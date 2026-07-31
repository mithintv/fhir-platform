/**
 * The unit of ingest work: read one chunk, normalize every line, write the
 * results. Shared verbatim by the single-threaded path and the worker threads,
 * so the two produce byte-identical output and the benchmark compares only
 * parallelism.
 */
import { readChunk } from './reader.js';
import type { Chunk } from './discover.js';
import { bump, countSkip } from './stats.js';
import type { IngestStats } from './stats.js';
import { normalizeResource } from '../normalize/index.js';
import type { NormalizeOptions } from '../normalize/index.js';
import type { StoreWriter } from '../store/writer.js';

export interface ProcessOptions {
  normalize: NormalizeOptions;
  /** When set, only these resource types are ingested. */
  allowedTypes?: ReadonlySet<string>;
  /** Read buffer size handed to the chunk reader. */
  highWaterMark?: number;
}

/**
 * Reads one chunk end to end: parse each line, normalize it, hand it to the
 * writer, and account for it in `stats`.
 *
 * Errors on a single line are counted and skipped rather than thrown, so one bad
 * record cannot abort a multi-gigabyte run. `stats` is mutated in place; each
 * caller (the single-threaded loop, or a worker) owns its own instance.
 */
export async function processChunk(
  chunk: Chunk,
  writer: StoreWriter,
  options: ProcessOptions,
  stats: IngestStats,
): Promise<void> {
  const result = await readChunk(
    chunk,
    (buffer, start, end) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.toString('utf8', start, end));
      } catch {
        // One malformed line must not abort a 3 GB run. Count it, keep a small
        // sample for debugging, and move on.
        stats.parseErrors += 1;
        if (stats.parseErrorSamples.length < 5) {
          stats.parseErrorSamples.push(buffer.toString('utf8', start, Math.min(end, start + 200)));
        }
        return;
      }

      const normalized = normalizeResource(
        parsed,
        chunk.resourceType,
        options.normalize,
        options.allowedTypes,
      );

      switch (normalized.kind) {
        case 'patient':
          writer.addPatient(normalized.patient);
          stats.patientRecords += 1;
          bump(stats.resourceCounts, 'Patient');
          for (const issue of normalized.patient.issues ?? []) bump(stats.issues, issue);
          break;

        case 'resource': {
          const { resource } = normalized;
          writer.addResource(resource);
          bump(stats.resourceCounts, resource.resourceType);
          for (const issue of resource.issues ?? []) bump(stats.issues, issue);
          if (!resource.patientId) bump(stats.unattributed, resource.resourceType);
          break;
        }

        case 'skipped':
          countSkip(stats, normalized.reason);
          break;
      }
    },
    { highWaterMark: options.highWaterMark },
  );

  stats.chunksRead += 1;
  stats.bytesRead += result.bytesRead;
  stats.linesRead += result.linesRead;
}
