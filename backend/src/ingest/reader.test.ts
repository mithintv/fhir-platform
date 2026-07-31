/**
 * Boundary tests for the chunk reader.
 *
 * This is the highest-risk code in the ingest: chunks split a file at arbitrary
 * byte offsets, and the line-reconciliation check in the CLI cannot catch a bug
 * here (both sides of that equation are derived from the same emission event).
 * So the invariant is tested directly: for any chunking of a file, every line
 * must be emitted exactly once, complete and parseable.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChunk } from './reader.js';
import type { Chunk } from './discover.js';

const scratch = mkdtempSync(join(tmpdir(), 'reader-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fileCounter = 0;

/** Writes lines to a fresh scratch file and returns its path and byte length. */
function writeNdjson(lines: string[], trailingNewline = true): { path: string; bytes: number } {
  const path = join(scratch, `f${fileCounter++}.ndjson`);
  const body = lines.join('\n') + (trailingNewline ? '\n' : '');
  writeFileSync(path, body, 'utf8');
  return { path, bytes: Buffer.byteLength(body, 'utf8') };
}

/** Reads a set of chunks and returns every emitted line, in emission order. */
async function readAll(path: string, ranges: [number, number][]): Promise<string[]> {
  const collected: string[] = [];
  for (const [start, end] of ranges) {
    const chunk: Chunk = { id: 0, path, resourceType: 'Observation', start, end };
    await readChunk(chunk, (buffer, from, to) => {
      collected.push(buffer.toString('utf8', from, to));
    });
  }
  return collected;
}

/** Splits [0, bytes) into fixed-size ranges. */
function evenRanges(bytes: number, size: number): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < bytes; start += size) {
    ranges.push([start, Math.min(start + size, bytes)]);
  }
  return ranges;
}

const RESOURCES = Array.from({ length: 200 }, (_, index) =>
  JSON.stringify({
    resourceType: 'Observation',
    id: `obs-${index}`,
    // Varying width so chunk boundaries land at many different places
    // relative to line starts.
    padding: 'x'.repeat(index % 37),
    subject: { reference: `Patient/p-${index % 7}` },
  }),
);

describe('readChunk', () => {
  it('reads every line exactly once when the file is one chunk', async () => {
    const { path, bytes } = writeNdjson(RESOURCES);
    const lines = await readAll(path, [[0, bytes]]);
    expect(lines).toEqual(RESOURCES);
  });

  it('emits only complete, parseable JSON regardless of chunk size', async () => {
    const { path, bytes } = writeNdjson(RESOURCES);
    for (const size of [7, 16, 64, 257, 1024]) {
      const lines = await readAll(path, evenRanges(bytes, size));
      for (const line of lines) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
    }
  });

  it('reads every line exactly once across every chunk size', async () => {
    const { path, bytes } = writeNdjson(RESOURCES);
    for (const size of [7, 16, 64, 257, 1024, 4096]) {
      const lines = await readAll(path, evenRanges(bytes, size));
      expect(lines, `chunk size ${size}`).toEqual(RESOURCES);
    }
  });

  /**
   * The dangerous case: a chunk boundary that lands exactly on a line start
   * (i.e. the preceding byte is the newline). Such a line is NOT a partial
   * line, so it must not be discarded as one — but the previous chunk has
   * already stopped, because the line begins at its exclusive `end`.
   */
  it('does not drop a line when a boundary falls exactly on a line start', async () => {
    const { path, bytes } = writeNdjson(RESOURCES);

    const offsets: number[] = [];
    let offset = 0;
    for (const line of RESOURCES) {
      offsets.push(offset);
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }

    // Split precisely at the start of each of several lines.
    for (const index of [1, 2, 50, 137, 199]) {
      const split = offsets[index]!;
      const lines = await readAll(path, [
        [0, split],
        [split, bytes],
      ]);
      expect(lines, `split at line ${index} (byte ${split})`).toEqual(RESOURCES);
    }
  });

  it('handles a final line with no trailing newline', async () => {
    const { path, bytes } = writeNdjson(RESOURCES, false);
    for (const size of [16, 257, 4096]) {
      const lines = await readAll(path, evenRanges(bytes, size));
      expect(lines, `chunk size ${size}`).toEqual(RESOURCES);
    }
  });

  it('handles CRLF line endings', async () => {
    const path = join(scratch, 'crlf.ndjson');
    const body = RESOURCES.join('\r\n') + '\r\n';
    writeFileSync(path, body, 'utf8');
    const bytes = Buffer.byteLength(body, 'utf8');
    const lines = await readAll(path, evenRanges(bytes, 128));
    expect(lines).toEqual(RESOURCES);
  });

  it('handles a line longer than the read buffer', async () => {
    const big = JSON.stringify({ resourceType: 'DocumentReference', data: 'y'.repeat(500_000) });
    const { path, bytes } = writeNdjson([RESOURCES[0]!, big, RESOURCES[1]!]);
    const lines = await readAll(path, evenRanges(bytes, 8192));
    expect(lines).toEqual([RESOURCES[0], big, RESOURCES[1]]);
  });
});
