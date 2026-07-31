#!/usr/bin/env node
/**
 * Ingest CLI.
 *
 *   ingest    parse the bulk export into the SQLite store
 *   profile   measure where single-threaded time actually goes
 *   bench     run the same ingest at several worker counts and compare
 *   stats     print the data-quality report from an existing store
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase, readMeta } from './store/db.js';
import { defaultWorkerCount, runIngest } from './ingest/run.js';
import type { IngestOptions, IngestResult } from './ingest/run.js';
import { profileIngest } from './bench/profile.js';
import type { IngestStats } from './ingest/stats.js';
import type { VerificationReport } from './ingest/verify.js';

const DEFAULT_SOURCE = resolve(
  import.meta.dirname,
  '../../sample-bulk-fhir-datasets-1000-patients',
);
const DEFAULT_DB = resolve(import.meta.dirname, '../../.data/fhir.db');

const MB = 1024 * 1024;

/** Byte count at a human scale, one unit up from where it stops being readable. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/** Thousands-separated integer. */
const fmtNum = (value: number): string => value.toLocaleString('en-US');

/** Milliseconds as seconds, to two decimal places. */
const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

/**
 * Prints a keyed counter as a descending table, noting how many rows were
 * elided so a truncated list never reads as a complete one.
 */
function printCounts(title: string, counts: Record<string, number>, limit = 30): void {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return;
  console.log(`\n${title}`);
  for (const [key, value] of entries.slice(0, limit)) {
    console.log(`  ${key.padEnd(38)} ${fmtNum(value).padStart(12)}`);
  }
  if (entries.length > limit) console.log(`  … ${entries.length - limit} more`);
}

/** Prints the volume totals and the data-quality breakdowns beneath them. */
function printStats(stats: IngestStats): void {
  console.log('\nIngest summary');
  console.log(`  files                                  ${fmtNum(stats.filesRead).padStart(12)}`);
  console.log(`  chunks                                 ${fmtNum(stats.chunksRead).padStart(12)}`);
  console.log(`  bytes                                  ${fmtBytes(stats.bytesRead).padStart(12)}`);
  console.log(`  lines                                  ${fmtNum(stats.linesRead).padStart(12)}`);
  console.log(`  parse errors                           ${fmtNum(stats.parseErrors).padStart(12)}`);

  printCounts('Resources by type', stats.resourceCounts);
  printCounts('Data-quality issues', stats.issues);
  printCounts('Unresolvable subject (by type)', stats.unattributed);
  printCounts('Skipped lines (by reason)', stats.skipped);

  if (stats.parseErrorSamples.length > 0) {
    console.log('\nParse error samples');
    for (const sample of stats.parseErrorSamples) console.log(`  ${sample.slice(0, 120)}`);
  }
}

/**
 * Prints the line-accounting identity: every line read is normalized, skipped
 * for a stated reason, or unparsable.
 *
 * This is a self-consistency check only — both sides derive from the same
 * emission event, so it cannot detect a line the reader never emitted. That is
 * what the independent checks in `verify.ts` are for.
 */
function reconcile(stats: IngestStats): void {
  const normalized = Object.values(stats.resourceCounts).reduce((a, b) => a + b, 0);
  const skipped = Object.values(stats.skipped).reduce((a, b) => a + b, 0);
  const accounted = normalized + skipped + stats.parseErrors;
  const label = accounted === stats.linesRead ? 'OK' : 'MISMATCH';
  console.log(
    `\nLine reconciliation: ${fmtNum(normalized)} normalized + ${fmtNum(skipped)} skipped + ` +
      `${fmtNum(stats.parseErrors)} unparsable = ${fmtNum(accounted)} of ${fmtNum(stats.linesRead)} [${label}]`,
  );
}

/** Prints each integrity check with its drift from the expected value. */
function printVerification(report: VerificationReport): void {
  console.log('\nIntegrity checks');
  for (const check of report.checks) {
    const mark = check.ok ? 'PASS' : 'FAIL';
    const delta = check.actual - check.expected;
    const drift = delta === 0 ? '' : ` (${delta > 0 ? '+' : ''}${fmtNum(delta)})`;
    console.log(
      `  [${mark}] ${check.name.padEnd(46)}` +
        `${fmtNum(check.expected).padStart(12)} expected  ` +
        `${fmtNum(check.actual).padStart(12)} actual${drift}`,
    );
    if (check.detail) console.log(`         ${check.detail}`);
  }
  if (!report.ok) console.log('\n  One or more integrity checks FAILED — the store is not trustworthy.');
}

/** Prints the per-stage timings, throughput and input/output sizes for a run. */
function printIngestResult(result: IngestResult): void {
  const { timings } = result;
  console.log('\nTiming');
  console.log(`  discover                               ${fmtSec(timings.discoverMs).padStart(12)}`);
  console.log(`  load (parse + normalize + write)       ${fmtSec(timings.loadMs).padStart(12)}`);
  console.log(`  build indexes                          ${fmtSec(timings.indexMs).padStart(12)}`);
  if (timings.verifyMs > 0) {
    console.log(`  verify (independent re-read)           ${fmtSec(timings.verifyMs).padStart(12)}`);
  }
  console.log(`  total                                  ${fmtSec(timings.totalMs).padStart(12)}`);
  const throughput = result.sourceBytes / MB / (timings.loadMs / 1000);
  console.log(`  load throughput                        ${throughput.toFixed(0).padStart(9)} MB/s`);
  console.log(`\nSource ${fmtBytes(result.sourceBytes)} in ${result.files.length} files ` +
    `(${result.chunkCount} chunks, ${result.workers} worker${result.workers === 1 ? '' : 's'})`);
  console.log(`Store  ${fmtBytes(result.dbBytes)}`);
}

/**
 * Builds a progress callback that rewrites a single stderr line every 5%.
 *
 * Progress goes to stderr so that piping stdout to a file yields just the
 * report.
 */
function progressReporter(): (completed: number, total: number) => void {
  let lastPrinted = 0;
  return (completed, total) => {
    const percent = Math.floor((completed / total) * 100);
    if (percent < lastPrinted + 5 && completed !== total) return;
    lastPrinted = percent;
    process.stderr.write(`\r  ${percent}% (${completed}/${total} chunks)   `);
    if (completed === total) process.stderr.write('\n');
  };
}

/**
 * Turns parsed CLI flags into ingest options, applying defaults.
 *
 * The `no-*` flags are negative by design: notes, indexes and verification are
 * all on by default, and each one is opted *out* of, so a plain `ingest` is
 * always the trustworthy configuration.
 */
function ingestOptionsFrom(values: Record<string, unknown>): IngestOptions {
  const workers = values['workers'] ? Number(values['workers']) : defaultWorkerCount();
  return {
    sourceDir: (values['source'] as string) ?? DEFAULT_SOURCE,
    dbPath: (values['db'] as string) ?? DEFAULT_DB,
    workers,
    chunkSizeBytes: Number(values['chunk-mb'] ?? 8) * MB,
    batchSize: Number(values['batch'] ?? 25_000),
    includeNoteText: values['no-notes'] !== true,
    maxNoteChars: Number(values['max-note-chars'] ?? 8_000),
    types: values['types'] ? String(values['types']).split(',') : undefined,
    buildIndexes: values['no-indexes'] !== true,
    verify: values['no-verify'] !== true,
    onProgress: values['quiet'] === true ? undefined : progressReporter(),
  };
}

const SHARED_OPTIONS = {
  source: { type: 'string' },
  db: { type: 'string' },
  workers: { type: 'string' },
  'chunk-mb': { type: 'string' },
  batch: { type: 'string' },
  types: { type: 'string' },
  'max-note-chars': { type: 'string' },
  'no-notes': { type: 'boolean' },
  'no-indexes': { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  quiet: { type: 'boolean' },
  'sample-mb': { type: 'string' },
  list: { type: 'string' },
} as const;

/**
 * Dispatches the subcommand named by the first argument, defaulting to
 * `ingest`. Exits non-zero when an integrity check fails, so a broken load
 * fails a script rather than passing quietly.
 */
async function main(): Promise<void> {
  const [command = 'ingest', ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: SHARED_OPTIONS, allowPositionals: false });

  switch (command) {
    case 'ingest': {
      const options = ingestOptionsFrom(values);
      console.log(`Ingesting ${options.sourceDir}`);
      console.log(`     into ${options.dbPath}  (${options.workers} workers)\n`);
      const result = await runIngest(options);
      printIngestResult(result);
      printStats(result.stats);
      reconcile(result.stats);
      if (result.verification) printVerification(result.verification);
      if (result.verification && !result.verification.ok) process.exitCode = 1;
      break;
    }

    case 'profile': {
      const sourceDir = (values['source'] as string) ?? DEFAULT_SOURCE;
      const sampleBytes = Number(values['sample-mb'] ?? 250) * MB;
      console.log(`Profiling ${sourceDir} (~${fmtBytes(sampleBytes)} sample)\n`);
      const result = await profileIngest(sourceDir, sampleBytes);

      console.log(
        `Sample: ${fmtBytes(result.sampledBytes)} across ${result.chunkCount} chunks, ` +
          `${fmtNum(result.sampledLines)} resources\n`,
      );
      console.log('  stage        cumulative    attributable      share');
      for (const stage of result.stages) {
        console.log(
          `  ${stage.stage.padEnd(11)}` +
            `${fmtSec(stage.cumulativeMs).padStart(11)}` +
            `${fmtSec(stage.deltaMs).padStart(16)}` +
            `${(stage.shareOfTotal * 100).toFixed(1).padStart(10)}%`,
        );
      }
      console.log(
        `\nProjected single-threaded full run over ${fmtBytes(result.totalSourceBytes)}: ` +
          `${result.projectedFullRunSeconds.toFixed(0)}s`,
      );
      break;
    }

    case 'bench': {
      const list = String(values['list'] ?? `1,${defaultWorkerCount()}`)
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isInteger(entry) && entry > 0);

      const results: { workers: number; result: IngestResult }[] = [];
      for (const workers of list) {
        // Verification re-reads the whole source; excluded so it cannot
        // distort the timings being compared.
        const options = { ...ingestOptionsFrom(values), workers, verify: false };
        console.log(`\n=== ${workers} worker${workers === 1 ? '' : 's'} ===`);
        const result = await runIngest(options);
        results.push({ workers, result });
        console.log(
          `  load ${fmtSec(result.timings.loadMs)}  index ${fmtSec(result.timings.indexMs)}  ` +
            `total ${fmtSec(result.timings.totalMs)}`,
        );
      }

      const baseline = results[0];
      if (!baseline) break;
      console.log('\nBefore / after');
      console.log('  workers        load       total     speedup   resources');
      for (const { workers, result } of results) {
        const speedup = baseline.result.timings.loadMs / result.timings.loadMs;
        const resources = Object.values(result.stats.resourceCounts).reduce((a, b) => a + b, 0);
        console.log(
          `  ${String(workers).padStart(7)}` +
            `${fmtSec(result.timings.loadMs).padStart(12)}` +
            `${fmtSec(result.timings.totalMs).padStart(12)}` +
            `${speedup.toFixed(2).padStart(11)}x` +
            `${fmtNum(resources).padStart(12)}`,
        );
      }
      break;
    }

    case 'stats': {
      const dbPath = (values['db'] as string) ?? DEFAULT_DB;
      const db = openDatabase(dbPath, { readOnly: true });
      const stats = readMeta<IngestStats>(db, 'stats');
      if (!stats) {
        console.error(`No ingest metadata in ${dbPath} — run \`ingest\` first.`);
        process.exitCode = 1;
        break;
      }
      const patients = db.prepare('SELECT count(*) AS n FROM patient').get() as { n: number };
      const resources = db.prepare('SELECT count(*) AS n FROM resource').get() as { n: number };
      const orphans = db
        .prepare(
          `SELECT count(DISTINCT r.patient_id) AS n FROM resource r
             LEFT JOIN patient p ON p.id = r.patient_id
            WHERE r.patient_id IS NOT NULL AND p.id IS NULL`,
        )
        .get() as { n: number };

      console.log(`Store ${dbPath}`);
      console.log(`  patients                               ${fmtNum(patients.n).padStart(12)}`);
      console.log(`  resources                              ${fmtNum(resources.n).padStart(12)}`);
      console.log(`  referenced-but-missing patients        ${fmtNum(orphans.n).padStart(12)}`);
      printStats(stats);
      reconcile(stats);
      db.close();
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: cli.ts <ingest|profile|bench|stats> [options]');
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
