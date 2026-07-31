#!/usr/bin/env node
/**
 * Ingest CLI.
 *
 *   ingest    parse the bulk export into the SQLite store
 *   bench     measure performance — stage breakdown by default,
 *             `--variants legacy@1,1` to compare whole configurations
 *   serve     read-only JSON API over the store, for the review UI
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { defaultWorkerCount, runIngest } from './ingest/run.js';
import type { IngestOptions, IngestResult } from './ingest/run.js';
import { profileIngest } from './bench/profile.js';
import { startServer } from './api/server.js';
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
  deep: { type: 'boolean' },
  list: { type: 'string' },
  variants: { type: 'string' },
  port: { type: 'string' },
  static: { type: 'string' },
  'dev-origin': { type: 'string' },
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

    case 'bench': {
      // One command, two questions:
      //   no flags     which STAGE of a run is slow    — samples 250 MB, ~10s
      //   --variants   which CONFIGURATION is faster   — full runs, ~40s each
      // The cheap sampled breakdown is the default because it is what tells you
      // what to change; the comparison is what proves the change worked.
      if (values['variants'] === undefined && values['list'] === undefined) {

      const sourceDir = (values['source'] as string) ?? DEFAULT_SOURCE;
      const sampleBytes = Number(values['sample-mb'] ?? 250) * MB;
      console.log(`Stage breakdown for ${sourceDir} (~${fmtBytes(sampleBytes)} sample)\n`);
      const result = await profileIngest(sourceDir, sampleBytes, values['deep'] === true);

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

      const detail = result.storeDetail;
      if (detail) {
        console.log(
          `\nStore breakdown — ${fmtNum(detail.resources)} resources, ` +
            `${fmtBytes(detail.jsonBytes)} of JSON, ${detail.avgJsonBytes.toFixed(0)} B/resource`,
        );
        console.log(
          `  rows: ${fmtNum(detail.rows.resources)} resource + ` +
            `${fmtNum(detail.rows.resourceCodings)} coding-link + ` +
            `${fmtNum(detail.rows.components)} component  ` +
            `(${fmtNum(detail.rows.distinctCodings)} distinct codings)\n`,
        );
        const row = (label: string, ms: number) =>
          console.log(`  ${label.padEnd(38)}${fmtSec(ms).padStart(9)}`);
        row('JSON.stringify only', detail.stringifyMs);
        row('insert resource rows (with blob)', detail.resourceOnlyMs);
        row('insert resource rows (no blob)', detail.noBlobMs);
        row('full writer (all tables)', detail.fullMs);
        console.log('');
        row('attributable to the JSON blob', detail.blobMs);
        row('attributable to side tables', detail.sideTableMs);
      }
        break;
      }


      // A variant is `[schema@]workers` — e.g. `1`, `8`, `legacy@1`.
      // `legacy` selects the pre-optimization flat coding table, so the
      // before/after in docs/PART_A.md is reproducible rather than asserted.
      const spec = String(values['variants'] ?? values['list'] ?? 'legacy@1,1');
      const variants = spec
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [head, tail] = entry.includes('@') ? entry.split('@') : ['current', entry];
          const workers = Number(tail);
          if (!Number.isInteger(workers) || workers < 1) {
            throw new Error(`bad variant "${entry}" — expected [legacy@]<workers>`);
          }
          const legacyCodings = head === 'legacy';
          if (head !== 'legacy' && head !== 'current') {
            throw new Error(`bad variant "${entry}" — schema must be "legacy" or "current"`);
          }
          return {
            label: `${legacyCodings ? 'legacy' : 'current'} @ ${workers}w`,
            workers,
            legacyCodings,
          };
        });

      const results: { label: string; result: IngestResult }[] = [];
      for (const variant of variants) {
        // Verification re-reads the whole source; excluded so it cannot
        // distort the timings being compared.
        const options = {
          ...ingestOptionsFrom(values),
          workers: variant.workers,
          legacyCodings: variant.legacyCodings,
          verify: false,
        };
        console.log(`\n=== ${variant.label} ===`);
        const result = await runIngest(options);
        results.push({ label: variant.label, result });
        console.log(
          `  load ${fmtSec(result.timings.loadMs)}  index ${fmtSec(result.timings.indexMs)}  ` +
            `total ${fmtSec(result.timings.totalMs)}`,
        );
      }

      const baseline = results[0];
      if (!baseline) break;
      console.log('\nComparison (first row is the baseline)');
      console.log('  variant                  load       index       total     speedup   resources');
      for (const { label, result } of results) {
        const speedup = baseline.result.timings.totalMs / result.timings.totalMs;
        const resources = Object.values(result.stats.resourceCounts).reduce((a, b) => a + b, 0);
        console.log(
          `  ${label.padEnd(20)}` +
            `${fmtSec(result.timings.loadMs).padStart(11)}` +
            `${fmtSec(result.timings.indexMs).padStart(12)}` +
            `${fmtSec(result.timings.totalMs).padStart(12)}` +
            `${speedup.toFixed(2).padStart(11)}x` +
            `${fmtNum(resources).padStart(12)}`,
        );
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: cli.ts <ingest|bench|serve> [options]');
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
