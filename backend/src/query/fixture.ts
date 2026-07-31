/**
 * An in-memory store built from raw FHIR fixtures, for the query tests.
 *
 * Deliberately goes through the real pipeline — `normalizeResource`, the real
 * `StoreWriter`, the real schema and indexes — rather than inserting rows by
 * hand. A test that hand-writes rows can only prove the query reads back what
 * the test wrote; this one proves the query reads back what the *ingest* writes,
 * which is the thing that has to be true in production.
 */
import { createIndexes, createTables, openDatabase } from '../store/db.js';
import type { Db } from '../store/db.js';
import { normalizeResource } from '../normalize/index.js';
import { StoreWriter } from '../store/writer.js';

/** Builds a store containing exactly the given raw FHIR resources. */
export function buildFixtureStore(resources: unknown[]): Db {
  const db = openDatabase(':memory:');
  createTables(db);

  const writer = new StoreWriter(db, 1000);
  for (const raw of resources) {
    const result = normalizeResource(raw, undefined);
    if (result.kind === 'patient') writer.addPatient(result.patient);
    else if (result.kind === 'resource') writer.addResource(result.resource);
  }
  writer.flush();

  createIndexes(db);
  return db;
}

/** A Patient with sensible defaults, overridable per test. */
export function patient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceType: 'Patient',
    id: 'p1',
    name: [{ use: 'official', family: 'Vance', given: ['Marion'] }],
    gender: 'female',
    birthDate: '1970-03-15',
    ...overrides,
  };
}

/**
 * An Observation carrying a single LOINC code and a quantity value.
 *
 * `effectiveDateTime` is required by the caller rather than defaulted: date
 * ordering is what most of these tests are about, so an implicit date would
 * hide the thing under test.
 */
export function observation(
  id: string,
  loincCode: string,
  effectiveDateTime: string,
  value?: { value: number; unit: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ system: 'http://loinc.org', code: loincCode }], text: `LOINC ${loincCode}` },
    effectiveDateTime,
    ...(value ? { valueQuantity: { value: value.value, unit: value.unit } } : {}),
    ...extra,
  };
}

export function condition(
  id: string,
  display: string,
  clinicalStatus: string | undefined,
  onsetDateTime: string,
): Record<string, unknown> {
  return {
    resourceType: 'Condition',
    id,
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '111', display }], text: display },
    onsetDateTime,
    ...(clinicalStatus
      ? {
          clinicalStatus: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
                code: clinicalStatus,
              },
            ],
          },
        }
      : {}),
  };
}

export function procedure(
  id: string,
  display: string,
  performedDateTime: string,
): Record<string, unknown> {
  return {
    resourceType: 'Procedure',
    id,
    status: 'completed',
    subject: { reference: 'Patient/p1' },
    code: { coding: [{ system: 'http://snomed.info/sct', code: '222', display }], text: display },
    performedDateTime,
  };
}
