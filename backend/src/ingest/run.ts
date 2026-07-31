/**
 * Ingest orchestrator.
 *
 * Two execution modes that produce identical output:
 *   workers = 1  -> everything runs in-process (the benchmark baseline)
 *   workers = N  -> chunks are handed to N worker threads from a shared queue
 *
 * The queue is pulled, not pushed: a worker gets its next chunk only when it
 * finishes the previous one. With chunks ranging over a 50x size spread, static
 * round-robin assignment would leave workers idle at the tail.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { discoverBulkFiles, planChunks } from './discover.js';
import type { BulkFile, Chunk } from './discover.js';
import { processChunk } from './process.js';
import type { ProcessOptions } from './process.js';
import { emptyStats, mergeStats } from './stats.js';
import type { IngestStats } from './stats.js';
import type { WorkerInit, WorkerRequest, WorkerResponse } from './worker.js';
import {
  closeDatabase,
  createIndexes,
  createTables,
  databaseSizeBytes,
  openDatabase,
  recordMeta,
} from '../store/db.js';
import { countSourceLines, verifyStore } from './verify.js';
import type { VerificationReport } from './verify.js';
import { StoreWriter } from '../store/writer.js';
import { DEFAULT_NORMALIZE_OPTIONS } from '../normalize/index.js';

export interface IngestOptions {
  sourceDir: string;
  dbPath: string;
  /** 1 = single-threaded baseline; defaults to cores - 2. */
  workers: number;
  chunkSizeBytes: number;
  batchSize: number;
  includeNoteText: boolean;
  maxNoteChars: number;
  /** Restrict ingest to these FHIR resource types. */
  types?: string[];
  /** Build query indexes after the load. Off only for benchmark isolation. */
  buildIndexes: boolean;
  /**
   * Run independent integrity checks after the load, including a fresh
   * byte-level line count. Costs one extra read pass; off during benchmarks so
   * it cannot pollute the timings being compared.
   */
  verify: boolean;
  /** Use the pre-optimization flat coding table. `bench` only. */
  legacyCodings?: boolean;
  highWaterMark?: number;
  onProgress?: (completed: number, total: number) => void;
}

export interface IngestTimings {
  discoverMs: number;
  loadMs: number;
  indexMs: number;
  verifyMs: number;
  totalMs: number;
}

export interface IngestResult {
  stats: IngestStats;
  timings: IngestTimings;
  files: BulkFile[];
  chunkCount: number;
  sourceBytes: number;
  dbBytes: number;
  workers: number;
  verification?: VerificationReport;
}

/**
 * Default parallelism: cores minus two, capped at 16.
 *
 * Two cores are left for the OS and the main thread's dispatch loop; beyond ~16
 * writers the shared SQLite file, not the CPU, is the limit.
 */
export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(16, cpus().length - 2));
}

const now = () => performance.now();

/**
 * Runs a full ingest: discover, plan chunks, load, index, verify.
 *
 * The store is recreated from scratch on every run, so the operation is
 * idempotent. Stats, timings and the verification report are written into
 * `ingest_meta` as well as returned, so `cli.ts stats` can report on a store
 * long after the run that produced it.
 */
export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const startedAt = now();

  const discoverStart = now();
  const files = await discoverBulkFiles(options.sourceDir);
  if (files.length === 0) throw new Error(`No NDJSON files found in ${options.sourceDir}`);
  const chunks = planChunks(files, options.chunkSizeBytes);
  const discoverMs = now() - discoverStart;

  // The main connection owns schema creation so workers never race on DDL.
  const db = openDatabase(options.dbPath, { fresh: true });
  createTables(db, options.legacyCodings ?? false);

  const loadStart = now();
  const stats =
    options.workers <= 1
      ? await runSingleThreaded(options, chunks)
      : await runParallel(options, chunks);
  const loadMs = now() - loadStart;

  const indexStart = now();
  if (options.buildIndexes) createIndexes(db, options.legacyCodings ?? false);
  const indexMs = now() - indexStart;

  // Verification re-reads the source independently of the chunk planner and the
  // reader, so it can catch boundary bugs that the in-run counters cannot.
  const verifyStart = now();
  const verification = options.verify
    ? verifyStore(db, stats, await countSourceLines(files))
    : undefined;
  const verifyMs = now() - verifyStart;

  const sourceBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  const timings: IngestTimings = {
    discoverMs,
    loadMs,
    indexMs,
    verifyMs,
    totalMs: now() - startedAt,
  };

  recordMeta(db, 'source_dir', options.sourceDir);
  // Stamped so the UI can state which ingest it is showing. A store written
  // before this key existed simply reports the date as unknown.
  recordMeta(db, 'ingested_at', new Date().toISOString());
  recordMeta(db, 'stats', stats);
  recordMeta(db, 'timings', timings);
  recordMeta(db, 'workers', options.workers);
  recordMeta(db, 'legacy_codings', options.legacyCodings ?? false);
  if (verification) recordMeta(db, 'verification', verification);
  recordMeta(db, 'files', files.map((file) => ({ name: file.fileName, bytes: file.sizeBytes })));

  // Fold the WAL back in before closing: it can reach ~2 GB after a bulk load,
  // and leaving it means later read-only connections see a pre-WAL snapshot.
  closeDatabase(db);

  return {
    stats,
    timings,
    files,
    chunkCount: chunks.length,
    sourceBytes,
    dbBytes: databaseSizeBytes(options.dbPath),
    workers: options.workers,
    ...(verification ? { verification } : {}),
  };
}

/** File size for reporting; 0 when the file cannot be stat'd. */
/** Projects run-level options down to what a single chunk needs. */
function processOptions(options: IngestOptions): ProcessOptions {
  return {
    normalize: {
      ...DEFAULT_NORMALIZE_OPTIONS,
      includeNoteText: options.includeNoteText,
      maxNoteChars: options.maxNoteChars,
    },
    allowedTypes: options.types ? new Set(options.types) : undefined,
    highWaterMark: options.highWaterMark,
  };
}

/** In-process load over every chunk in order — the benchmark's baseline. */
async function runSingleThreaded(options: IngestOptions, chunks: Chunk[]): Promise<IngestStats> {
  const db = openDatabase(options.dbPath);
  const writer = new StoreWriter(db, options.batchSize, options.legacyCodings ?? false);
  const stats = emptyStats();
  const shared = processOptions(options);

  let completed = 0;
  for (const chunk of chunks) {
    await processChunk(chunk, writer, shared, stats);
    options.onProgress?.(++completed, chunks.length);
  }

  writer.flush();
  closeDatabase(db);
  stats.filesRead = new Set(chunks.map((chunk) => chunk.path)).size;
  return stats;
}

/** Resolves the worker entry point, running under tsx or from compiled output. */
function workerEntry(): { url: URL; execArgv?: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith('.ts')) {
    // Under tsx the loader is not inherited by worker threads; register it.
    return { url: new URL('./worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
  }
  return { url: new URL('./worker.js', import.meta.url) };
}

/**
 * Load across worker threads, each pulling its next chunk on completion.
 *
 * Failures are collected rather than thrown immediately: every worker is allowed
 * to exit and report its own error, so a single failure surfaces alongside the
 * others instead of masking them. The promise settles once all workers exit.
 */
async function runParallel(options: IngestOptions, chunks: Chunk[]): Promise<IngestStats> {
  const entry = workerEntry();
  const workerCount = Math.min(options.workers, chunks.length);
  const merged = emptyStats();

  /** Chunks not yet handed to a worker. Pulled from the front. */
  const pending = [...chunks];
  /** Chunk each worker currently holds, so a death can put it back. */
  const inFlight = new Map<Worker, Chunk>();
  const done = new Set<number>();
  let liveWorkers = workerCount;
  let aborted = false;
  const failures: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const dispatch = (worker: Worker): void => {
      if (aborted || pending.length === 0) {
        inFlight.delete(worker);
        worker.postMessage({ type: 'finish' } satisfies WorkerRequest);
        return;
      }
      const chunk = pending.shift()!;
      inFlight.set(worker, chunk);
      worker.postMessage({ type: 'chunk', chunk } satisfies WorkerRequest);
    };

    const finish = (): void => {
      if (failures.length > 0) {
        reject(new Error(failures.join('; ')));
        return;
      }
      // A worker that dies without reporting an error would otherwise leave its
      // chunk unprocessed and the run looking successful.
      if (done.size !== chunks.length) {
        reject(
          new Error(
            `only ${done.size} of ${chunks.length} chunks completed — ` +
              `${chunks.length - done.size} were lost with a worker`,
          ),
        );
        return;
      }
      resolve();
    };

    for (let id = 0; id < workerCount; id += 1) {
      const init: WorkerInit = {
        workerId: id,
        dbPath: options.dbPath,
        batchSize: options.batchSize,
        includeNoteText: options.includeNoteText,
        maxNoteChars: options.maxNoteChars,
        allowedTypes: options.types,
        highWaterMark: options.highWaterMark,
        legacyCodings: options.legacyCodings ?? false,
      };

      const worker = new Worker(entry.url, {
        workerData: init,
        ...(entry.execArgv ? { execArgv: entry.execArgv } : {}),
      });

      worker.on('message', (message: WorkerResponse) => {
        switch (message.type) {
          case 'ready':
            dispatch(worker);
            break;
          case 'chunk-done':
            done.add(message.chunkId);
            inFlight.delete(worker);
            options.onProgress?.(done.size, chunks.length);
            dispatch(worker);
            break;
          case 'finished':
            mergeStats(merged, message.stats);
            inFlight.delete(worker);
            void worker.terminate();
            break;
          case 'failed':
            // Stop handing out work: the run is going to fail, and the other
            // workers would otherwise process the whole export first.
            aborted = true;
            failures.push(message.message);
            inFlight.delete(worker);
            void worker.terminate();
            break;
        }
      });

      worker.on('error', (error) => {
        aborted = true;
        failures.push(error.message);
      });

      worker.on('exit', () => {
        // A worker holding a chunk when it exits died mid-work. Put the chunk
        // back so a surviving worker can take it, rather than losing it.
        const orphaned = inFlight.get(worker);
        if (orphaned) {
          inFlight.delete(worker);
          pending.unshift(orphaned);
        }
        liveWorkers -= 1;
        if (liveWorkers === 0) finish();
      });
    }
  });

  merged.filesRead = new Set(chunks.map((chunk) => chunk.path)).size;
  return merged;
}
