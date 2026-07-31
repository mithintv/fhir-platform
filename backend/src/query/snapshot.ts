/**
 * The clinical snapshot: demographics, active conditions, recent procedures,
 * and the key-observation panel.
 *
 * The organising rule is that every section accounts for what it did *not*
 * find. Conditions are partitioned into active / inactive / undetermined
 * rather than filtered to active, because a Condition with no `clinicalStatus`
 * is not an inactive one — it is a record that never said. The observation
 * panel returns an entry for every metric whether or not the patient has a
 * reading, so an absent BMI is a visible statement instead of a missing row.
 */
import type { Db } from '../store/db.js';
import type {
  ClinicalSnapshot,
  ConditionEntry,
  KeyObservation,
  ProcedureEntry,
  ResourceMix,
} from './dto.js';
import type {
  NormalizedCondition,
  NormalizedObservation,
  NormalizedProcedure,
} from '../model/types.js';
import { LOINC, METRIC_BY_CODE, METRIC_PANEL, PANEL_CODES } from './codes.js';
import { parseDate } from '../fhir/dates.js';
import {
  parseRecord,
  toConditionEntry,
  toDateInfo,
  toProcedureEntry,
  toReading,
} from './hydrate.js';
import { computeAge, getPatientRecord, toDemographics } from './patients.js';

/** How many procedures the snapshot lists before deferring to the timeline. */
const RECENT_PROCEDURE_LIMIT = 10;

/**
 * FHIR `Condition.clinicalStatus` values that mean the condition is over.
 * Anything else recorded is treated as active; anything *absent* is neither.
 */
const INACTIVE_STATUSES = new Set(['resolved', 'remission', 'inactive']);

interface JsonRow {
  json: string;
}

/**
 * Counts every resource type held for this patient, and how many of each
 * cannot be placed on a timeline.
 *
 * The undated count is surfaced because it is large and structural in this
 * dataset — `Specimen` carries no date on any type-appropriate element — and a
 * timeline that silently drops 66,850 rows should say that it did.
 */
function readResourceMix(db: Db, patientId: string): ResourceMix[] {
  const rows = db
    .prepare(
      `SELECT resource_type AS resourceType,
              count(*) AS count,
              sum(effective_sort IS NULL) AS undated
         FROM resource
        WHERE patient_id = ?
        GROUP BY resource_type
        ORDER BY count(*) DESC`,
    )
    .all(patientId) as unknown as ResourceMix[];
  return rows.map((row) => ({ ...row, undated: Number(row.undated) }));
}

/**
 * Reads every Condition for the patient, partitioned by clinical status.
 *
 * All conditions are fetched rather than filtered in SQL because the partition
 * depends on `clinicalStatus`, which lives in the JSON record and not in a
 * column. Condition volume is bounded per patient (tens, not thousands), so
 * this stays a small read.
 */
function readConditions(
  db: Db,
  patientId: string,
): { active: ConditionEntry[]; inactiveCount: number; undetermined: ConditionEntry[] } {
  const rows = db
    .prepare(
      `SELECT json FROM resource
        WHERE patient_id = ? AND resource_type = 'Condition'
        ORDER BY effective_sort DESC`,
    )
    .all(patientId) as unknown as JsonRow[];

  const active: ConditionEntry[] = [];
  const undetermined: ConditionEntry[] = [];
  let inactiveCount = 0;

  for (const row of rows) {
    const condition = parseRecord<NormalizedCondition>(row.json, 'Condition');
    const status = condition.clinicalStatus;
    if (status === undefined) {
      undetermined.push(toConditionEntry(condition));
    } else if (INACTIVE_STATUSES.has(status)) {
      inactiveCount += 1;
    } else {
      active.push(toConditionEntry(condition));
    }
  }

  return { active, inactiveCount, undetermined };
}

/** The most recent procedures, plus the total so the UI can say "10 of 167". */
function readProcedures(
  db: Db,
  patientId: string,
): { recent: ProcedureEntry[]; total: number } {
  const totalRow = db
    .prepare(
      `SELECT count(*) AS total FROM resource
        WHERE patient_id = ? AND resource_type = 'Procedure'`,
    )
    .get(patientId) as { total: number } | undefined;

  // NULLs last: an undated procedure is not the most recent one.
  const rows = db
    .prepare(
      `SELECT json FROM resource
        WHERE patient_id = ? AND resource_type = 'Procedure'
        ORDER BY (effective_sort IS NULL), effective_sort DESC
        LIMIT ?`,
    )
    .all(patientId, RECENT_PROCEDURE_LIMIT) as unknown as JsonRow[];

  return {
    total: totalRow?.total ?? 0,
    recent: rows.map((row) =>
      toProcedureEntry(parseRecord<NormalizedProcedure>(row.json, 'Procedure')),
    ),
  };
}

/** One matched panel observation, before any record is hydrated. */
interface PanelMatch {
  code: string;
  id: string;
  /** The raw FHIR date string, enough to date a reading without its record. */
  effective_value: string | null;
}

/**
 * Reads the key-observation panel.
 *
 * Matching happens on `coding.code`, never on display text — see `codes.ts` for
 * why that distinction is load-bearing.
 *
 * The `MATERIALIZED` CTE is the point of this query's shape, and it is not
 * decoration. Written as the obvious single join —
 *
 *     FROM resource r JOIN resource_coding rc ON rc.resource_id = r.id ...
 *     WHERE r.patient_id = ? AND r.resource_type = 'Observation'
 *
 * — SQLite drives the join from `resource_coding_by_resource` using only that
 * index's leading column, `resource_type = 'Observation'`. That matches every
 * observation-coding row in the export, and each one then probes `resource_pk`
 * to fetch the whole `resource` row — 730-byte JSON blob included — purely to
 * test `patient_id`. The single predicate that reduces 1.4M rows to a few
 * hundred is applied last instead of first: 1.31s for the busiest patient.
 *
 * Materializing this patient's observation ids first makes the driving set
 * small and indexed (`resource_patient_type_time`), so the coding association
 * is probed on a full key rather than scanned. Same rows, same order.
 *
 * Only ids and dates go through the CTE, never `json`. Carrying the blob would
 * materialize ~15 MB for a patient with 21,046 observations in order to display
 * five values; instead the latest reading per metric is hydrated afterwards by
 * primary key — at most five rows. The earliest reading only contributes a
 * date, which `effective_value` already carries.
 *
 * A patient has at most a few thousand panel observations, so the whole matched
 * set is read: that gives the reading count and the earliest date for free,
 * which is the context that makes a single latest value interpretable.
 */
function readKeyObservations(db: Db, patientId: string): KeyObservation[] {
  const placeholders = PANEL_CODES.map(() => '?').join(',');
  const matches = db
    .prepare(
      `WITH observations AS MATERIALIZED (
         SELECT id, effective_sort, effective_value
           FROM resource
          WHERE patient_id = ? AND resource_type = 'Observation'
       )
       SELECT c.code AS code, o.id AS id, o.effective_value AS effective_value
         FROM observations o
         JOIN resource_coding rc
           ON rc.resource_type = 'Observation' AND rc.resource_id = o.id
         JOIN coding c
           ON c.id = rc.coding_id
        WHERE c.system = ?
          AND c.code IN (${placeholders})
        ORDER BY (o.effective_sort IS NULL), o.effective_sort DESC`,
    )
    .all(patientId, LOINC, ...PANEL_CODES) as unknown as PanelMatch[];

  // Matches arrive newest-first, so each metric's first row is its latest
  // reading and its last row is the earliest.
  const byMetric = new Map<string, PanelMatch[]>();
  for (const match of matches) {
    const definition = METRIC_BY_CODE.get(match.code);
    if (!definition) continue;
    const bucket = byMetric.get(definition.metric);
    if (bucket) bucket.push(match);
    else byMetric.set(definition.metric, [match]);
  }

  const latestIds = [...byMetric.values()].map((bucket) => (bucket[0] as PanelMatch).id);
  const records = hydrateObservations(db, latestIds);

  return METRIC_PANEL.map((definition): KeyObservation => {
    const matched = byMetric.get(definition.metric);
    if (!matched || matched.length === 0) {
      return {
        kind: 'absent',
        metric: definition.metric,
        label: definition.label,
        codes: [...definition.codes],
        note: definition.absentNote,
      };
    }

    const latestMatch = matched[0] as PanelMatch;
    const earliestMatch = matched[matched.length - 1] as PanelMatch;
    const latest = records.get(latestMatch.id);

    // The id came from the store a moment ago, so a miss here means the row
    // vanished between the two queries — report it rather than render a blank.
    if (!latest) {
      throw new Error(`Observation/${latestMatch.id} disappeared between panel queries`);
    }

    return {
      kind: 'recorded',
      metric: definition.metric,
      label: definition.label,
      codes: [...definition.codes],
      latest: toReading(latest),
      count: matched.length,
      // Re-parsed from the stored date string rather than hydrating a second
      // record: `parseDate` recovers the precision the column does not carry.
      earliest: toDateInfo(parseDate(earliestMatch.effective_value)),
    };
  });
}

/**
 * Fetches full Observation records by id, keyed for lookup.
 *
 * Uses `resource_pk`, so this is a handful of index seeks regardless of how
 * many observations the patient has.
 */
function hydrateObservations(db: Db, ids: string[]): Map<string, NormalizedObservation> {
  const records = new Map<string, NormalizedObservation>();
  if (ids.length === 0) return records;

  const rows = db
    .prepare(
      `SELECT id, json FROM resource
        WHERE resource_type = 'Observation' AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as unknown as { id: string; json: string }[];

  for (const row of rows) {
    records.set(row.id, parseRecord<NormalizedObservation>(row.json, `Observation/${row.id}`));
  }
  return records;
}

/**
 * Builds the whole snapshot for one patient.
 *
 * Returns `undefined` for an unknown patient id so the route layer can answer
 * 404 — throwing here would make "no such patient" indistinguishable from a
 * store defect.
 *
 * `now` is threaded through to `computeAge` so tests can pin the clock.
 */
export function getClinicalSnapshot(
  db: Db,
  patientId: string,
  now: Date = new Date(),
): ClinicalSnapshot | undefined {
  const patient = getPatientRecord(db, patientId);
  if (!patient) return undefined;

  const conditions = readConditions(db, patientId);
  const procedures = readProcedures(db, patientId);

  return {
    patient: toDemographics(patient),
    age: computeAge(patient, now),
    activeConditions: conditions.active,
    inactiveConditionCount: conditions.inactiveCount,
    undeterminedConditions: conditions.undetermined,
    recentProcedures: procedures.recent,
    procedureCount: procedures.total,
    keyObservations: readKeyObservations(db, patientId),
    resourceMix: readResourceMix(db, patientId),
  };
}
