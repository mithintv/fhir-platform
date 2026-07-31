/**
 * Gathering the facts an eligibility decision is made from.
 *
 * This module reads; it decides nothing. The split matters because the per-
 * patient view and the 1,132-patient cohort report have to agree exactly, and
 * the only way to guarantee that is for both to call the *same* pure evaluator
 * (`evaluate.ts`) over the same evidence shape. What differs between them is
 * only how the evidence is fetched: one patient at a time, or the whole store
 * in three queries.
 *
 * The two fetch paths do not share a query shape, and that is deliberate — see
 * `readBmiReadings` for why asking the same question from the patient end
 * rather than the code end is the difference between tens of rows and a
 * whole-store scan.
 *
 * ## Why codes are resolved to ids first
 *
 * The store models codings as a dictionary (`coding`) plus an association
 * (`resource_coding`) — see `store/schema.ts`. Resolving the policy's
 * `(system, code)` pairs to integer coding ids up front means the evidence
 * queries filter on `resource_coding.coding_id`, which is the leading column of
 * `resource_coding_by_coding`. Matching on `system`/`code` inside the evidence
 * query instead would force a join against the dictionary on every candidate
 * row. It also produces something the report needs anyway: the list of policy
 * codes that match *nothing* in this store.
 */
import type { Db } from '../store/db.js';
import type { NormalizedCondition, NormalizedDate } from '../model/types.js';
import { parseDate } from '../fhir/dates.js';
import type { CodeSetId, Policy, PolicyCode } from './policy.js';
import { policyCodes } from './policy.js';

/** A BMI observation, reduced to what the threshold test needs. */
export interface BmiReading {
  id: string;
  ref: string;
  /** `null` when the observation carried no numeric value. */
  value: number | null;
  unit: string | null;
  date: NormalizedDate | undefined;
  /** Epoch millis, or `null` for an undated observation. */
  sortKey: number | null;
}

/** A resource matched by one of the policy's code sets. */
export interface CodedHit {
  setId: CodeSetId;
  resourceType: string;
  id: string;
  ref: string;
  display: string | null;
  date: NormalizedDate | undefined;
  sortKey: number | null;
  matchedCode: PolicyCode;
}

/** Everything the evaluator is allowed to look at for one patient. */
export interface PatientEvidence {
  patientId: string;
  /** Every BMI observation, newest first; undated readings last. */
  bmiReadings: BmiReading[];
  /** Every code-set match, newest first; undated last. */
  hits: CodedHit[];
}

/** The policy's codes, resolved against this store's coding dictionary. */
export interface ResolvedCodes {
  /** coding id -> which set it belongs to and which policy code it is. */
  byCodingId: Map<number, { setId: CodeSetId; code: PolicyCode }>;
  /** The coding ids for the BMI code specifically. */
  bmiCodingIds: number[];
  /** Ids for everything except BMI. */
  otherCodingIds: number[];
  /** Policy codes with no row in the `coding` dictionary at all. */
  unmatched: { setId: CodeSetId; code: PolicyCode }[];
}

/**
 * Condition statuses that mean the comorbidity is over.
 *
 * Matches the snapshot's partition (`query/snapshot.ts`) so the two views cannot
 * disagree about what "active" means. A Condition with *no* `clinicalStatus` is
 * not excluded: the record never said it resolved, and dropping a coded
 * diagnosis because its status element is absent would under-count comorbidity
 * on exactly the incomplete records this tool exists to flag.
 */
const RESOLVED_CLINICAL_STATUSES = new Set(['resolved', 'remission', 'inactive']);

/** Verification statuses that mean the Condition was withdrawn or denied. */
const REFUTED_VERIFICATION_STATUSES = new Set(['refuted', 'entered-in-error']);

/** Resolves every policy code to its coding id, noting the ones with no rows. */
export function resolveCodes(db: Db, policy: Policy): ResolvedCodes {
  const lookup = db.prepare('SELECT id FROM coding WHERE system = ? AND code = ?');

  const byCodingId = new Map<number, { setId: CodeSetId; code: PolicyCode }>();
  const bmiCodingIds: number[] = [];
  const otherCodingIds: number[] = [];
  const unmatched: { setId: CodeSetId; code: PolicyCode }[] = [];

  for (const entry of policyCodes(policy)) {
    const row = lookup.get(entry.code.system, entry.code.code) as { id: number } | undefined;
    if (!row) {
      unmatched.push(entry);
      continue;
    }
    byCodingId.set(row.id, entry);
    if (entry.setId === 'bmi') bmiCodingIds.push(row.id);
    else otherCodingIds.push(row.id);
  }

  return { byCodingId, bmiCodingIds, otherCodingIds, unmatched };
}

interface BmiRow {
  patient_id: string | null;
  coding_id: number;
  id: string;
  value_num: number | null;
  value_unit: string | null;
  effective_value: string | null;
  effective_sort: number | null;
}

interface HitRow {
  patient_id: string | null;
  coding_id: number;
  resource_type: string;
  id: string;
  code_text: string | null;
  effective_value: string | null;
  effective_sort: number | null;
  status: string | null;
  condition_json: string | null;
}

/**
 * Builds the `IN (…)` list for a set of coding ids.
 *
 * The ids come from `resolveCodes`, never from a caller, so interpolating them
 * is safe — and it keeps the parameter count fixed as the policy's code sets
 * grow.
 */
function inList(ids: readonly number[]): string {
  return ids.join(',');
}

/** Rows in date order: newest first, undated last. */
const NEWEST_FIRST = 'ORDER BY (r.effective_sort IS NULL), r.effective_sort DESC';

/**
 * The two reads are the same question asked from opposite ends, and the
 * difference is load-bearing.
 *
 * **Cohort**: drive from `resource_coding_by_coding`. There is no patient to
 * start from, and the policy's ~35 codings select ~46,000 of 1.44M resources,
 * so starting at the code is exactly right.
 *
 * **One patient**: drive from the patient. Reusing the cohort shape with an
 * `AND r.patient_id = ?` tacked on looks equivalent and is not: SQLite still
 * leads with `coding_id`, walks all 46,000 matches, fetches each `resource` row
 * to test its `patient_id`, and throws away every one but a handful. That is a
 * whole-store scan to answer a question about one patient — 150 ms warm, 1.4 s
 * cold, and it gets no cheaper as the store grows. Materializing the patient's
 * own resources first (via `resource_patient_time`) makes the driving set tens
 * of rows, and the coding association is then probed on the full key of
 * `resource_coding_by_resource`. Same rows, same order.
 *
 * This is the identical trap documented at length in `query/snapshot.ts`, which
 * is the other place a code-set lookup meets a patient filter.
 */
function readBmiReadings(db: Db, codingIds: readonly number[], patientId?: string): BmiRow[] {
  if (codingIds.length === 0) return [];

  if (patientId === undefined) {
    return db
      .prepare(
        `SELECT r.patient_id, rc.coding_id, r.id, r.value_num, r.value_unit,
                r.effective_value, r.effective_sort
           FROM resource_coding rc
           JOIN resource r ON r.resource_type = 'Observation' AND r.id = rc.resource_id
          WHERE rc.resource_type = 'Observation'
            AND rc.coding_id IN (${inList(codingIds)})
          ${NEWEST_FIRST}`,
      )
      .all() as unknown as BmiRow[];
  }

  return db
    .prepare(
      `WITH mine AS MATERIALIZED (
         SELECT id, patient_id, value_num, value_unit, effective_value, effective_sort
           FROM resource
          WHERE patient_id = ? AND resource_type = 'Observation'
       )
       SELECT r.patient_id, rc.coding_id, r.id, r.value_num, r.value_unit,
              r.effective_value, r.effective_sort
         FROM mine r
         JOIN resource_coding rc
           ON rc.resource_type = 'Observation' AND rc.resource_id = r.id
        WHERE rc.coding_id IN (${inList(codingIds)})
        ${NEWEST_FIRST}`,
    )
    .all(patientId) as unknown as BmiRow[];
}

/**
 * Reads every non-BMI code-set match.
 *
 * Comorbidity decisions need a Condition's `clinicalStatus`, which lives in the
 * JSON record and not in a column — but the psychological-evaluation related set
 * alone matches ~19,000 Procedures and Observations. Selecting `json`
 * unconditionally would drag megabytes of blob through the cohort read to answer
 * a question only Conditions can be asked, so the cohort path takes it under a
 * `CASE` and the patient path fetches it separately by primary key. Everything
 * else is decided from the `status` column.
 *
 * See {@link readBmiReadings} for why the two paths drive from opposite ends.
 */
function readCodedHits(db: Db, codingIds: readonly number[], patientId?: string): HitRow[] {
  if (codingIds.length === 0) return [];

  if (patientId === undefined) {
    return db
      .prepare(
        `SELECT r.patient_id, rc.coding_id, rc.resource_type, r.id, r.code_text,
                r.effective_value, r.effective_sort, r.status,
                CASE WHEN rc.resource_type = 'Condition' THEN r.json END AS condition_json
           FROM resource_coding rc
           JOIN resource r ON r.resource_type = rc.resource_type AND r.id = rc.resource_id
          WHERE rc.coding_id IN (${inList(codingIds)})
          ${NEWEST_FIRST}`,
      )
      .all() as unknown as HitRow[];
  }

  // The CTE deliberately omits `json`: a patient with 29,539 resources would
  // otherwise materialize ~21 MB of blob to look at a few dozen rows.
  const rows = db
    .prepare(
      `WITH mine AS MATERIALIZED (
         SELECT id, resource_type, patient_id, code_text, effective_value, effective_sort, status
           FROM resource
          WHERE patient_id = ?
       )
       SELECT r.patient_id, rc.coding_id, r.resource_type, r.id, r.code_text,
              r.effective_value, r.effective_sort, r.status,
              NULL AS condition_json
         FROM mine r
         JOIN resource_coding rc
           ON rc.resource_type = r.resource_type AND rc.resource_id = r.id
        WHERE rc.coding_id IN (${inList(codingIds)})
        ${NEWEST_FIRST}`,
    )
    .all(patientId) as unknown as HitRow[];

  attachConditionJson(db, rows);
  return rows;
}

/**
 * Fills in `condition_json` for the Condition rows of a single-patient read.
 *
 * A handful of primary-key seeks, because a patient has tens of matching
 * Conditions, not thousands.
 */
function attachConditionJson(db: Db, rows: HitRow[]): void {
  const conditions = rows.filter((row) => row.resource_type === 'Condition');
  if (conditions.length === 0) return;

  const records = db
    .prepare(
      `SELECT id, json FROM resource
        WHERE resource_type = 'Condition'
          AND id IN (${conditions.map(() => '?').join(',')})`,
    )
    .all(...conditions.map((row) => row.id)) as unknown as { id: string; json: string }[];

  const byId = new Map(records.map((record) => [record.id, record.json]));
  for (const row of conditions) row.condition_json = byId.get(row.id) ?? null;
}

/**
 * Decides whether a matched resource may be used as evidence at all.
 *
 * Returns the reason for rejection, or `null` to keep it. Withdrawn records are
 * dropped rather than surfaced as related evidence: a Condition marked
 * `entered-in-error` is not weak evidence of a comorbidity, it is a statement
 * that the comorbidity was never recorded in the first place.
 */
function rejectionReason(row: HitRow): string | null {
  if (row.status !== null && row.status === 'entered-in-error') return 'entered-in-error';

  if (row.condition_json !== null) {
    let condition: NormalizedCondition;
    try {
      condition = JSON.parse(row.condition_json) as NormalizedCondition;
    } catch (cause) {
      throw new Error(`Stored record for Condition/${row.id} is not valid JSON`, { cause });
    }
    const verification = condition.verificationStatus;
    if (verification && REFUTED_VERIFICATION_STATUSES.has(verification)) return verification;
    const clinical = condition.clinicalStatus;
    if (clinical && RESOLVED_CLINICAL_STATUSES.has(clinical)) return clinical;
  }

  return null;
}

/** Groups rows by patient id, dropping rows with no resolvable subject. */
function byPatient<T extends { patient_id: string | null }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (row.patient_id === null) continue;
    const bucket = grouped.get(row.patient_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.patient_id, [row]);
  }
  return grouped;
}

function toBmiReading(row: BmiRow): BmiReading {
  return {
    id: row.id,
    ref: `Observation/${row.id}`,
    value: row.value_num,
    unit: row.value_unit,
    date: parseDate(row.effective_value),
    sortKey: row.effective_sort,
  };
}

function toCodedHit(row: HitRow, resolved: ResolvedCodes): CodedHit | undefined {
  const matched = resolved.byCodingId.get(row.coding_id);
  if (!matched) return undefined;
  return {
    setId: matched.setId,
    resourceType: row.resource_type,
    id: row.id,
    ref: `${row.resource_type}/${row.id}`,
    display: row.code_text ?? matched.code.display,
    date: parseDate(row.effective_value),
    sortKey: row.effective_sort,
    matchedCode: matched.code,
  };
}

/** How many resources and distinct subjects one policy coding actually matched. */
export interface CodingReach {
  resources: number;
  /** Distinct subject ids, including subjects with no Patient resource. */
  patients: number;
}

export interface CohortEvidence {
  byPatient: Map<string, PatientEvidence>;
  /** coding id -> reach across the whole store, cohort membership aside. */
  reach: Map<number, CodingReach>;
}

/**
 * Counts how far each coding reaches, from rows already in hand.
 *
 * Deliberately folded into the same pass rather than asked as its own
 * `GROUP BY` query. Both readings of the store cost the same thing — ~46,000
 * random seeks from `resource_coding` into a 2.6 GB `resource` table — so
 * running the aggregate separately doubled the report's wall clock for numbers
 * the scan had already touched. Counted before the `entered-in-error` filter,
 * because the question is what the export contains for a code, not what
 * survived review.
 */
function tallyReach(
  reach: Map<number, CodingReach>,
  codingId: number,
  rows: { patient_id: string | null }[],
): void {
  const subjects = new Set<string>();
  for (const row of rows) if (row.patient_id !== null) subjects.add(row.patient_id);
  reach.set(codingId, { resources: rows.length, patients: subjects.size });
}

/** Buckets rows by the coding that matched them. */
function groupByCoding<T extends { coding_id: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.coding_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.coding_id, [row]);
  }
  return grouped;
}

/**
 * Gathers evidence for every patient the store holds a Patient resource for.
 *
 * Patients with no matching resources still get an (empty) entry, because "this
 * patient has no BMI" is a finding the evaluator has to make, not a patient it
 * should skip.
 */
export function gatherCohortEvidence(
  db: Db,
  policy: Policy,
  resolved: ResolvedCodes = resolveCodes(db, policy),
): CohortEvidence {
  const allBmiRows = readBmiReadings(db, resolved.bmiCodingIds);
  const allHitRows = readCodedHits(db, resolved.otherCodingIds);

  const reach = new Map<number, CodingReach>();
  for (const [codingId, rows] of groupByCoding([...allBmiRows, ...allHitRows])) {
    tallyReach(reach, codingId, rows);
  }

  const bmiRows = byPatient(allBmiRows);
  const hitRows = byPatient(allHitRows);
  const patients = db.prepare('SELECT id FROM patient').all() as unknown as { id: string }[];

  const byPatientEvidence = new Map<string, PatientEvidence>();
  for (const { id } of patients) {
    byPatientEvidence.set(id, {
      patientId: id,
      bmiReadings: (bmiRows.get(id) ?? []).map(toBmiReading),
      hits: (hitRows.get(id) ?? [])
        .filter((row) => rejectionReason(row) === null)
        .map((row) => toCodedHit(row, resolved))
        .filter((hit): hit is CodedHit => hit !== undefined),
    });
  }
  return { byPatient: byPatientEvidence, reach };
}

/**
 * Gathers evidence for one patient.
 *
 * Returns `undefined` for an unknown id so the route layer can answer 404 — an
 * empty assessment would be indistinguishable from a patient with no data.
 */
export function gatherPatientEvidence(
  db: Db,
  policy: Policy,
  patientId: string,
  resolved: ResolvedCodes = resolveCodes(db, policy),
): PatientEvidence | undefined {
  const exists = db.prepare('SELECT 1 FROM patient WHERE id = ?').get(patientId);
  if (!exists) return undefined;

  return {
    patientId,
    bmiReadings: readBmiReadings(db, resolved.bmiCodingIds, patientId).map(toBmiReading),
    hits: readCodedHits(db, resolved.otherCodingIds, patientId)
      .filter((row) => rejectionReason(row) === null)
      .map((row) => toCodedHit(row, resolved))
      .filter((hit): hit is CodedHit => hit !== undefined),
  };
}

/**
 * The newest clinical date anywhere in the store.
 *
 * This is the store's data horizon, and it is what `asOf` defaults to. See
 * `resolveAsOf` in `evaluate.ts` for why that default is not the wall clock.
 */
export function latestClinicalDate(db: Db): number | undefined {
  const row = db.prepare('SELECT max(effective_sort) AS latest FROM resource').get() as
    | { latest: number | null }
    | undefined;
  return row?.latest ?? undefined;
}
