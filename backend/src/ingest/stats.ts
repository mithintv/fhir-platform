/**
 * Ingest counters and data-quality accounting.
 *
 * Nothing is silently dropped: every line that does not end up attached to a
 * patient is counted under a reason, and the totals are asserted to reconcile
 * at the end of a run.
 */
import type { SkipReason } from '../normalize/index.js';

export interface IngestStats {
  filesRead: number;
  chunksRead: number;
  bytesRead: number;
  linesRead: number;
  /** Lines that were not valid JSON. */
  parseErrors: number;
  /** Lines dropped before normalization, by reason. */
  skipped: Record<string, number>;
  /** Normalized resources by FHIR resource type. */
  resourceCounts: Record<string, number>;
  /** Patient resources seen (before de-duplication). */
  patientRecords: number;
  /** Resources with no resolvable subject reference, by resource type. */
  unattributed: Record<string, number>;
  /** Per-resource data-quality issues, by issue code. */
  issues: Record<string, number>;
  /** Sample of raw lines that failed to parse, for debugging. */
  parseErrorSamples: string[];
}

/** A zeroed counter set. Each thread accumulates into its own instance. */
export function emptyStats(): IngestStats {
  return {
    filesRead: 0,
    chunksRead: 0,
    bytesRead: 0,
    linesRead: 0,
    parseErrors: 0,
    skipped: {},
    resourceCounts: {},
    patientRecords: 0,
    unattributed: {},
    issues: {},
    parseErrorSamples: [],
  };
}

/** Increments a keyed counter, creating the key on first use. */
export function bump(counter: Record<string, number>, key: string, by = 1): void {
  counter[key] = (counter[key] ?? 0) + by;
}

/** Records a line that was read but deliberately not stored, under its reason. */
export function countSkip(stats: IngestStats, reason: SkipReason): void {
  bump(stats.skipped, reason);
}

/**
 * Folds one worker's counters into the run total, in place.
 *
 * `filesRead` is summed like everything else, but the orchestrator overwrites it
 * afterwards: workers share files, so summing would double-count them.
 */
export function mergeStats(target: IngestStats, source: IngestStats): IngestStats {
  target.filesRead += source.filesRead;
  target.chunksRead += source.chunksRead;
  target.bytesRead += source.bytesRead;
  target.linesRead += source.linesRead;
  target.parseErrors += source.parseErrors;
  target.patientRecords += source.patientRecords;
  for (const [key, value] of Object.entries(source.skipped)) bump(target.skipped, key, value);
  for (const [key, value] of Object.entries(source.resourceCounts)) bump(target.resourceCounts, key, value);
  for (const [key, value] of Object.entries(source.unattributed)) bump(target.unattributed, key, value);
  for (const [key, value] of Object.entries(source.issues)) bump(target.issues, key, value);
  for (const sample of source.parseErrorSamples) {
    if (target.parseErrorSamples.length < 5) target.parseErrorSamples.push(sample);
  }
  return target;
}
