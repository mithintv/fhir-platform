/**
 * Store-level provenance for the UI header.
 *
 * The integrity checks are surfaced rather than kept in the CLI: a reviewer
 * looking at a patient screen should be able to see that the ingest behind it
 * reconciled, without running anything.
 */
import { readMeta } from '../store/db.js';
import type { Db } from '../store/db.js';
import type { VerificationReport } from '../ingest/verify.js';
import type { StoreMeta } from './dto.js';

export function getStoreMeta(db: Db): StoreMeta {
  const patients = db.prepare('SELECT count(*) AS n FROM patient').get() as { n: number };
  const resources = db.prepare('SELECT count(*) AS n FROM resource').get() as { n: number };
  const verification = readMeta<VerificationReport>(db, 'verification');

  return {
    patients: patients.n,
    resources: resources.n,
    ingestedAt: readMeta<string>(db, 'ingested_at') ?? null,
    // `--no-verify` and older stores both leave this absent; an empty list means
    // "no checks recorded", which the UI states rather than reading as "passed".
    verification: (verification?.checks ?? []).map((check) => ({
      name: check.name,
      expected: check.expected,
      actual: check.actual,
      ok: check.ok,
    })),
  };
}
