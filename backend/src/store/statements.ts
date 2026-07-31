/**
 * Every INSERT the store issues, plus the parameter order each one expects.
 *
 * The SQL and its bind list live together deliberately. They were previously
 * duplicated between the writer and the store profiler, and a schema change
 * silently desynchronised the two — the column list moved, the positional
 * arguments did not. Co-locating them means a column can only be added or
 * removed in one place.
 */
import type { NormalizedPatient, NormalizedResource } from '../model/types.js';
import { bind, bindBool, bindIssues } from './db.js';
import type { Bindable } from './db.js';
import { numericValue } from '../fhir/concept.js';

export const INSERT_PATIENT = `
INSERT OR REPLACE INTO patient
  (id, name_text, family, given, gender, birth_date, birth_sort, deceased, deceased_date,
   birth_sex, race, ethnicity, marital_status, city, state, postal_code, issues, json)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

export const INSERT_RESOURCE = `
INSERT INTO resource
  (id, resource_type, patient_id, encounter_id, status, code_text,
   effective_value, effective_sort, value_num, value_unit, value_text, issues, json)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** Pre-optimization write path, used only by `bench` to measure the change. */
export const INSERT_LEGACY_CODING = `
INSERT INTO resource_coding_flat (resource_id, resource_type, patient_id, system, code, display)
VALUES (?,?,?,?,?,?)`;

export const INSERT_RESOURCE_CODING = `
INSERT INTO resource_coding (resource_type, resource_id, coding_id, ordinal) VALUES (?,?,?,?)`;

/** Paired: insert-if-absent then read back the id, against the UNIQUE key. */
export const INSERT_CODING = `INSERT OR IGNORE INTO coding (system, code, display) VALUES (?,?,?)`;
export const SELECT_CODING = `SELECT id FROM coding WHERE system = ? AND code = ?`;

export const UPSERT_META = `INSERT OR REPLACE INTO ingest_meta (key, value) VALUES (?, ?)`;

export const INSERT_COMPONENT = `
INSERT INTO observation_component
  (observation_id, patient_id, coding_id, value_num, value_unit)
VALUES (?,?,?,?,?)`;

/** Bind list for {@link INSERT_PATIENT}, in column order. */
export function patientParams(patient: NormalizedPatient): Bindable[] {
  return [
    patient.id,
    bind(patient.name?.text),
    bind(patient.name?.family),
    bind(patient.name?.given?.join(' ')),
    bind(patient.gender),
    bind(patient.birthDate?.value),
    bind(patient.birthDate?.sortKey),
    bindBool(patient.deceased),
    bind(patient.deceasedDate?.value),
    bind(patient.birthSex),
    bind(patient.race),
    bind(patient.ethnicity),
    bind(patient.maritalStatus?.text),
    bind(patient.address?.city),
    bind(patient.address?.state),
    bind(patient.address?.postalCode),
    bindIssues(patient.issues),
    JSON.stringify(patient),
  ];
}

/**
 * Bind list for {@link INSERT_RESOURCE}, in column order.
 *
 * `json` is a parameter rather than derived here so callers that pre-serialize
 * (the profiler) and callers that serialize inline (the writer) share one
 * definition of every other column.
 */
export function resourceParams(resource: NormalizedResource, json: string): Bindable[] {
  const value = observationValueColumns(resource);
  return [
    resource.id,
    resource.resourceType,
    bind(resource.patientId),
    bind(resource.encounterId),
    bind(resource.status),
    bind(resource.code?.text),
    bind(resource.effective?.value),
    bind(resource.effective?.sortKey),
    value.num,
    value.unit,
    value.text,
    bindIssues(resource.issues),
    json,
  ];
}

/**
 * Flattens an observation `value[x]` into the numeric/unit/text columns.
 *
 * Non-Observation resources have no value element, so every column is null.
 */
export function observationValueColumns(resource: NormalizedResource): {
  num: Bindable;
  unit: Bindable;
  text: Bindable;
} {
  const value = (resource as { value?: NonNullable<unknown> }).value as
    | import('../model/types.js').ObservationValue
    | undefined;
  if (!value) return { num: null, unit: null, text: null };

  switch (value.kind) {
    case 'quantity':
      return { num: bind(value.value), unit: bind(value.unit), text: null };
    case 'integer':
      return { num: bind(value.value), unit: null, text: null };
    case 'codeable':
      return { num: null, unit: null, text: bind(value.concept.text) };
    case 'string':
      return { num: null, unit: null, text: value.value };
    case 'boolean':
      return { num: value.value ? 1 : 0, unit: null, text: String(value.value) };
    case 'datetime':
      return { num: null, unit: null, text: value.value };
    default:
      return { num: null, unit: null, text: null };
  }
}

export { numericValue };
