/**
 * Independent integrity checks.
 *
 * The CLI's line reconciliation is self-consistent by construction: both sides
 * of the equation are derived from the same emission event inside the reader,
 * so a chunk-boundary bug that drops a line makes BOTH sides short and still
 * reports OK. (Exactly such a bug existed — see `reader.test.ts`.)
 *
 * These checks are deliberately independent of the ingest path:
 *   countSourceLines  re-reads the files and counts newline bytes directly,
 *                     never touching the chunk planner or the reader
 *   verifyStore       counts rows actually committed to SQLite, rather than
 *                     trusting the in-memory counters
 */
import { createReadStream } from 'node:fs';
import type { BulkFile } from './discover.js';
import type { IngestStats } from './stats.js';
import type { Db } from '../store/db.js';

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Counts non-empty lines in a file by scanning raw bytes.
 *
 * "Non-empty" matches the reader's own emission rule: a line consisting only of
 * a newline (optionally preceded by a carriage return) is not emitted, so it
 * must not be counted here either.
 */
export async function countFileLines(path: string): Promise<number> {
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let lines = 0;
  let lineHasContent = false;

  for await (const piece of stream) {
    const buffer = piece as Buffer;
    for (let index = 0; index < buffer.length; index += 1) {
      const byte = buffer[index];
      if (byte === NEWLINE) {
        if (lineHasContent) lines += 1;
        lineHasContent = false;
      } else if (byte !== CARRIAGE_RETURN) {
        lineHasContent = true;
      }
    }
  }

  // A final line with no trailing newline still counts.
  if (lineHasContent) lines += 1;
  return lines;
}

export interface SourceLineCount {
  totalLines: number;
  byFile: { fileName: string; lines: number }[];
}

/**
 * Counts lines across the whole export, per file and in total.
 *
 * Sequential by design: this runs after the load, and reading the files one at a
 * time keeps the count a clean second opinion rather than a second workload.
 */
export async function countSourceLines(files: readonly BulkFile[]): Promise<SourceLineCount> {
  const byFile: { fileName: string; lines: number }[] = [];
  let totalLines = 0;
  for (const file of files) {
    const lines = await countFileLines(file.path);
    byFile.push({ fileName: file.fileName, lines });
    totalLines += lines;
  }
  return { totalLines, byFile };
}

export interface CheckResult {
  name: string;
  expected: number;
  actual: number;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  checks: CheckResult[];
  ok: boolean;
}

/**
 * Compares what the ingest believes it did against two independent sources of
 * truth: a fresh byte-level line count, and the committed row counts.
 */
export function verifyStore(
  db: Db,
  stats: IngestStats,
  sourceLines: SourceLineCount | undefined,
): VerificationReport {
  const checks: CheckResult[] = [];

  const count = (sql: string): number => {
    const row = db.prepare(sql).get() as { n: number } | undefined;
    return row?.n ?? 0;
  };

  if (sourceLines) {
    checks.push({
      name: 'lines read vs. independent byte-level count',
      expected: sourceLines.totalLines,
      actual: stats.linesRead,
      ok: sourceLines.totalLines === stats.linesRead,
      detail: 'catches chunk-boundary loss or duplication',
    });
  }

  const normalizedResources = Object.entries(stats.resourceCounts)
    .filter(([type]) => type !== 'Patient')
    .reduce((total, [, value]) => total + value, 0);

  checks.push({
    name: 'resource rows committed vs. normalized',
    expected: normalizedResources,
    actual: count('SELECT count(*) AS n FROM resource'),
    ok: count('SELECT count(*) AS n FROM resource') === normalizedResources,
    detail: 'catches records counted but never written',
  });

  // Patients use INSERT OR REPLACE, so a repeated id collapses to one row.
  // That is intentional de-duplication, not loss — report it as such.
  const patientRows = count('SELECT count(*) AS n FROM patient');
  const duplicatePatients = stats.patientRecords - patientRows;
  checks.push({
    name: 'patient rows committed vs. seen',
    expected: stats.patientRecords,
    actual: patientRows,
    ok: duplicatePatients >= 0,
    detail:
      duplicatePatients > 0
        ? `${duplicatePatients} duplicate patient id(s) collapsed`
        : 'no duplicate patient ids',
  });

  // Every resource row must be uniquely addressable, because Part D grounds AI
  // citations by resolving `ResourceType/id` back to a stored record.
  const distinctResources = count(
    'SELECT count(*) AS n FROM (SELECT DISTINCT resource_type, id FROM resource)',
  );
  checks.push({
    name: 'resource ids unique per type',
    expected: count('SELECT count(*) AS n FROM resource'),
    actual: distinctResources,
    ok: distinctResources === count('SELECT count(*) AS n FROM resource'),
    detail: 'duplicate ids would break AI-citation grounding in Part D',
  });

  return { checks, ok: checks.every((check) => check.ok) };
}
