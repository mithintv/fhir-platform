/**
 * Stage profiler — answers "what should be optimized first?" with a measurement
 * instead of an assumption.
 *
 * The same sample of chunks is replayed five times, each pass doing strictly
 * more work than the last. Subtracting adjacent passes attributes wall-clock to
 * a stage without needing a sampling profiler:
 *
 *   read            bytes off disk, no decoding
 *   +decode         UTF-8 decode each line to a string
 *   +parse          JSON.parse each line
 *   +normalize      build the internal model
 *   +store          insert into SQLite
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { discoverBulkFiles, planChunks } from '../ingest/discover.js';
import { readChunk } from '../ingest/reader.js';
import type { Chunk } from '../ingest/discover.js';
import { normalizeResource } from '../normalize/index.js';
import { DEFAULT_NORMALIZE_OPTIONS } from '../normalize/index.js';
import { createTables, openDatabase } from '../store/db.js';
import { StoreWriter } from '../store/writer.js';
import { emptyStats } from '../ingest/stats.js';
import { processChunk } from '../ingest/process.js';

export interface StageTiming {
  stage: string;
  cumulativeMs: number;
  /** Time attributable to this stage alone. */
  deltaMs: number;
  shareOfTotal: number;
}

export interface ProfileResult {
  sampledBytes: number;
  sampledLines: number;
  chunkCount: number;
  stages: StageTiming[];
  /** Extrapolated single-threaded cost for the whole dataset. */
  projectedFullRunSeconds: number;
  totalSourceBytes: number;
}

const now = () => performance.now();

/** Picks chunks round-robin across resource types so the sample isn't skewed. */
function sampleChunks(chunks: Chunk[], targetBytes: number): Chunk[] {
  const byType = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const list = byType.get(chunk.resourceType);
    if (list) list.push(chunk);
    else byType.set(chunk.resourceType, [chunk]);
  }

  const picked: Chunk[] = [];
  let bytes = 0;
  let index = 0;
  let exhausted = false;

  while (!exhausted && bytes < targetBytes) {
    exhausted = true;
    for (const list of byType.values()) {
      const chunk = list[index];
      if (!chunk) continue;
      exhausted = false;
      picked.push(chunk);
      bytes += chunk.end - chunk.start;
      if (bytes >= targetBytes) break;
    }
    index += 1;
  }
  return picked;
}

/**
 * Runs the five-pass profile over a sample of the export and attributes
 * wall-clock to each stage.
 *
 * Passes run in a fixed order on the same chunks, so the OS page cache is warm
 * from pass 2 onward — the `read` figure is therefore a cold-cache cost and the
 * later deltas are not inflated by re-reading from disk.
 */
export async function profileIngest(
  sourceDir: string,
  targetSampleBytes = 250 * 1024 * 1024,
): Promise<ProfileResult> {
  const files = await discoverBulkFiles(sourceDir);
  const totalSourceBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  const chunks = planChunks(files, 8 * 1024 * 1024);
  const sample = sampleChunks(chunks, targetSampleBytes);

  let sampledBytes = 0;
  let sampledLines = 0;

  // Pass 1 — read only.
  let start = now();
  for (const chunk of sample) {
    const result = await readChunk(chunk, () => {});
    sampledBytes += result.bytesRead;
    sampledLines += result.linesRead;
  }
  const readMs = now() - start;

  // Pass 2 — read + UTF-8 decode.
  start = now();
  for (const chunk of sample) {
    await readChunk(chunk, (buffer, from, to) => {
      // `void` keeps V8 from eliminating the decode as dead code.
      void buffer.toString('utf8', from, to).length;
    });
  }
  const decodeMs = now() - start;

  // Pass 3 — read + decode + JSON.parse.
  start = now();
  for (const chunk of sample) {
    await readChunk(chunk, (buffer, from, to) => {
      try {
        void JSON.parse(buffer.toString('utf8', from, to));
      } catch {
        /* counted properly during real ingest */
      }
    });
  }
  const parseMs = now() - start;

  // Pass 4 — read + decode + parse + normalize.
  start = now();
  for (const chunk of sample) {
    await readChunk(chunk, (buffer, from, to) => {
      try {
        const raw: unknown = JSON.parse(buffer.toString('utf8', from, to));
        void normalizeResource(raw, chunk.resourceType, DEFAULT_NORMALIZE_OPTIONS);
      } catch {
        /* ignored */
      }
    });
  }
  const normalizeMs = now() - start;

  // Pass 5 — the full pipeline, including SQLite writes.
  const scratchDb = join(tmpdir(), `fhir-profile-${process.pid}.db`);
  const db = openDatabase(scratchDb, { fresh: true });
  createTables(db);
  const writer = new StoreWriter(db, 25_000);
  const stats = emptyStats();

  start = now();
  for (const chunk of sample) {
    await processChunk(chunk, writer, { normalize: DEFAULT_NORMALIZE_OPTIONS }, stats);
  }
  writer.flush();
  const storeMs = now() - start;

  db.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${scratchDb}${suffix}`, { force: true });

  const cumulative: [string, number][] = [
    ['read', readMs],
    ['decode', decodeMs],
    ['parse', parseMs],
    ['normalize', normalizeMs],
    ['store', storeMs],
  ];

  const total = storeMs;
  let previous = 0;
  const stages: StageTiming[] = cumulative.map(([stage, cumulativeMs]) => {
    const deltaMs = cumulativeMs - previous;
    previous = cumulativeMs;
    return { stage, cumulativeMs, deltaMs, shareOfTotal: deltaMs / total };
  });

  return {
    sampledBytes,
    sampledLines,
    chunkCount: sample.length,
    stages,
    projectedFullRunSeconds: (total / 1000) * (totalSourceBytes / sampledBytes),
    totalSourceBytes,
  };
}
