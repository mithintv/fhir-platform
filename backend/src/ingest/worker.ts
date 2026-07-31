/**
 * Worker-thread entry point.
 *
 * Each worker owns its own SQLite connection and pulls chunks from the main
 * thread one at a time. Normalized records never cross the thread boundary —
 * they go straight from the worker that parsed them into the database — which
 * avoids paying structured-clone costs on ~350 MB of records.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../store/db.js';
import { StoreWriter } from '../store/writer.js';
import { processChunk } from './process.js';
import type { ProcessOptions } from './process.js';
import type { Chunk } from './discover.js';
import { emptyStats } from './stats.js';
import type { IngestStats } from './stats.js';
import { DEFAULT_NORMALIZE_OPTIONS } from '../normalize/index.js';

export interface WorkerInit {
  workerId: number;
  dbPath: string;
  batchSize: number;
  includeNoteText: boolean;
  maxNoteChars: number;
  allowedTypes?: string[];
  highWaterMark?: number;
}

/** Main thread → worker. */
export type WorkerRequest = { type: 'chunk'; chunk: Chunk } | { type: 'finish' };

/** Worker → main thread. */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'chunk-done'; chunkId: number }
  | { type: 'finished'; stats: IngestStats; writerStats: unknown }
  | { type: 'failed'; message: string; chunkId?: number };

if (!parentPort) throw new Error('worker.ts must be run as a worker thread');

const port = parentPort;
const init = workerData as WorkerInit;

const db = openDatabase(init.dbPath);
const writer = new StoreWriter(db, init.batchSize);
const stats = emptyStats();

const options: ProcessOptions = {
  normalize: {
    ...DEFAULT_NORMALIZE_OPTIONS,
    includeNoteText: init.includeNoteText,
    maxNoteChars: init.maxNoteChars,
  },
  allowedTypes: init.allowedTypes ? new Set(init.allowedTypes) : undefined,
  highWaterMark: init.highWaterMark,
};

/**
 * Messages are handled strictly in order. `node:sqlite` is synchronous, so
 * overlapping two chunks inside one worker would interleave writes on the same
 * connection for no throughput gain.
 */
let queue: Promise<void> = Promise.resolve();

port.on('message', (message: WorkerRequest) => {
  queue = queue.then(async () => {
    try {
      if (message.type === 'chunk') {
        await processChunk(message.chunk, writer, options, stats);
        port.postMessage({ type: 'chunk-done', chunkId: message.chunk.id } satisfies WorkerResponse);
        return;
      }

      writer.flush();
      db.close();
      port.postMessage({
        type: 'finished',
        stats,
        writerStats: writer.stats,
      } satisfies WorkerResponse);
    } catch (error) {
      port.postMessage({
        type: 'failed',
        message: error instanceof Error ? error.message : String(error),
        chunkId: message.type === 'chunk' ? message.chunk.id : undefined,
      } satisfies WorkerResponse);
    }
  });
});

port.postMessage({ type: 'ready' } satisfies WorkerResponse);
