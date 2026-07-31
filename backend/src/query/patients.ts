/**
 * Patient selector queries: search, paging, and the demographics header.
 */
import type { Db } from '../store/db.js';
import type { NormalizedPatient } from '../model/types.js';
import type { Age, PatientDemographics, PatientListItem, PatientSearchResult } from './dto.js';
import { toDateInfo } from './hydrate.js';

/** Hard ceiling on a page, so a hand-written `?limit=` cannot ask for 1,132 rows. */
const MAX_LIMIT = 200;

interface PatientRow {
  id: string;
  name_text: string | null;
  gender: string | null;
  birth_date: string | null;
  deceased: number | null;
}

/**
 * Escapes a user string for use inside a `LIKE` pattern.
 *
 * Without this, a search for `100%` matches every patient, and a search for
 * `_` matches all of them too — LIKE wildcards inside user input change what
 * the query means. `\` is declared as the escape character at the call site.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export interface SearchOptions {
  /** Matched against name and id. Empty or absent means "all patients". */
  query?: string;
  limit?: number;
  offset?: number;
}

/**
 * Searches patients by name or id.
 *
 * Both the count and the page come from the same predicate so the total can
 * never disagree with what paging walks through. At 1,132 patients an unindexed
 * `LIKE '%term%'` scan is the right trade: it matches mid-name and mid-id,
 * which a prefix index could not, and the table is small enough that the scan
 * is not worth designing around.
 */
export function searchPatients(db: Db, options: SearchOptions = {}): PatientSearchResult {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  const term = options.query?.trim();

  const where = term ? `WHERE (name_text LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')` : '';
  const params = term ? [`%${escapeLike(term)}%`, `%${escapeLike(term)}%`] : [];

  const totalRow = db.prepare(`SELECT count(*) AS total FROM patient ${where}`).get(...params) as
    | { total: number }
    | undefined;

  // Patients with no name sort last rather than first: an unnamed record is the
  // least useful thing to show at the top of a selector.
  const rows = db
    .prepare(
      `SELECT id, name_text, gender, birth_date, deceased
         FROM patient ${where}
        ORDER BY (name_text IS NULL), name_text, id
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as PatientRow[];

  return {
    total: totalRow?.total ?? 0,
    limit,
    offset,
    items: rows.map(
      (row): PatientListItem => ({
        id: row.id,
        name: row.name_text,
        gender: row.gender,
        birthDate: row.birth_date,
        deceased: row.deceased === 1,
      }),
    ),
  };
}

/** Reads the stored Patient record, or `undefined` if the id is unknown. */
export function getPatientRecord(db: Db, patientId: string): NormalizedPatient | undefined {
  const row = db.prepare('SELECT json FROM patient WHERE id = ?').get(patientId) as
    | { json: string }
    | undefined;
  return row ? (JSON.parse(row.json) as NormalizedPatient) : undefined;
}

export function toDemographics(patient: NormalizedPatient): PatientDemographics {
  const address = patient.address
    ? {
        city: patient.address.city,
        state: patient.address.state,
        postalCode: patient.address.postalCode,
      }
    : null;

  return {
    id: patient.id,
    ref: patient.ref,
    name: patient.name?.text ?? null,
    gender: patient.gender ?? null,
    birthSex: patient.birthSex ?? null,
    birthDate: toDateInfo(patient.birthDate),
    deceased: patient.deceased === true || patient.deceasedDate !== undefined,
    deceasedDate: toDateInfo(patient.deceasedDate),
    maritalStatus: patient.maritalStatus?.text ?? null,
    race: patient.race ?? null,
    ethnicity: patient.ethnicity ?? null,
    address,
    issues: patient.issues ?? [],
  };
}

/**
 * Whole years between two instants, counting the anniversary rather than
 * dividing by 365.25 — the divide is wrong by a day either side of a birthday
 * and wrong by more across leap years.
 */
function wholeYearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const monthDelta = to.getUTCMonth() - from.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && to.getUTCDate() < from.getUTCDate())) years -= 1;
  return years;
}

/**
 * Computes age, keeping "no birth date" and "died" as distinct outcomes.
 *
 * A deceased patient's age is computed at date of death, not today. Showing a
 * running age for someone who died in 1998 is not a rounding error, it is a
 * false statement on a clinical screen.
 *
 * `now` is a parameter so the result is testable without freezing the clock.
 */
export function computeAge(patient: NormalizedPatient, now: Date = new Date()): Age {
  const birth = patient.birthDate;
  if (!birth) return { kind: 'unknown', reason: 'no-birth-date' };

  const birthDate = new Date(birth.sortKey);
  const death = patient.deceasedDate;

  if (death) {
    const deathDate = new Date(death.sortKey);
    const years = wholeYearsBetween(birthDate, deathDate);
    // A death recorded before birth is contradictory source data. Report it as
    // unknown rather than rendering a negative age.
    if (years < 0) return { kind: 'unknown', reason: 'died-before-birth-date' };
    return { kind: 'at-death', years, diedOn: death.value };
  }

  const years = wholeYearsBetween(birthDate, now);
  // A birth date in the future is contradictory too, and for a different
  // reason than a death before birth — the UI says which.
  if (years < 0) return { kind: 'unknown', reason: 'birth-date-in-future' };
  return { kind: 'living', years, asOf: now.toISOString().slice(0, 10) };
}
