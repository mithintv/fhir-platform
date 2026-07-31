/**
 * Builds the fields every normalized resource shares.
 */
import type { NormalizedResource } from '../model/types.js';
import { pickEffectiveDate } from '../fhir/dates.js';
import { firstConcept, parseConcepts } from '../fhir/concept.js';
import { resolveLocalId, resolvePatientId } from '../fhir/reference.js';
import { compact, path, str } from '../fhir/safe.js';
import type { JsonObject } from '../fhir/safe.js';

/**
 * Date elements to try, per resource type, in clinical-preference order.
 *
 * The list is intentionally explicit rather than "any field ending in Date":
 * for a Condition, `onsetDateTime` (when it started) and `recordedDate` (when
 * someone typed it in) mean different things, and the timeline should prefer
 * the clinical event over the clerical one.
 */
export const EFFECTIVE_DATE_ELEMENTS: Record<string, readonly string[]> = {
  Observation: ['effectiveDateTime', 'effectivePeriod.start', 'effectiveInstant', 'issued'],
  Condition: ['onsetDateTime', 'onsetPeriod.start', 'recordedDate', 'abatementDateTime'],
  Procedure: ['performedDateTime', 'performedPeriod.start', 'performedString'],
  Encounter: ['period.start', 'period.end'],
  DocumentReference: ['date', 'context.period.start'],
  MedicationRequest: ['authoredOn', 'dispenseRequest.validityPeriod.start'],
  AllergyIntolerance: ['onsetDateTime', 'recordedDate'],
  DiagnosticReport: ['effectiveDateTime', 'effectivePeriod.start', 'issued'],
  Immunization: ['occurrenceDateTime', 'recorded'],
  ServiceRequest: ['occurrenceDateTime', 'occurrencePeriod.start', 'authoredOn'],
  EpisodeOfCare: ['period.start'],
  Specimen: ['collection.collectedDateTime', 'receivedTime'],
  Device: ['manufactureDate', 'expirationDate'],
  CarePlan: ['period.start', 'created'],
  Claim: ['created', 'billablePeriod.start'],
  ExplanationOfBenefit: ['created', 'billablePeriod.start'],
};

/** Fallback order for resource types we have no explicit mapping for. */
const GENERIC_DATE_ELEMENTS = [
  'effectiveDateTime',
  'effectivePeriod.start',
  'occurrenceDateTime',
  'occurrencePeriod.start',
  'performedDateTime',
  'performedPeriod.start',
  'onsetDateTime',
  'period.start',
  'authoredOn',
  'recordedDate',
  'issued',
  'date',
  'created',
  'meta.lastUpdated',
] as const;

/**
 * Elements carrying the code that identifies *what a resource is*, per type.
 *
 * FHIR does not put this in one place: most resources use `code`, but
 * MedicationRequest uses `medicationCodeableConcept`, Immunization uses
 * `vaccineCode`, and Encounter/EpisodeOfCare use `type`. Several of those are
 * 0..* arrays rather than single objects, which is why lookup goes through
 * `firstConcept`. Reading only `code`/`type` left 218,582 resources (15% of the
 * export) with no queryable code at all.
 */
export const CODE_ELEMENTS: Record<string, readonly string[]> = {
  Encounter: ['type', 'serviceType'],
  EpisodeOfCare: ['type'],
  MedicationRequest: ['medicationCodeableConcept'],
  MedicationAdministration: ['medicationCodeableConcept'],
  MedicationStatement: ['medicationCodeableConcept'],
  Immunization: ['vaccineCode'],
  PractitionerRole: ['code', 'specialty'],
  Location: ['type', 'physicalType'],
  Organization: ['type'],
  Device: ['type'],
  Specimen: ['type'],
  DocumentReference: ['type'],
};

/** Tried for any resource type without an entry above. */
const DEFAULT_CODE_ELEMENTS = ['code', 'type'] as const;

/** Elements that may hold the subject reference, in order of preference. */
const SUBJECT_ELEMENTS = ['subject', 'patient', 'beneficiary', 'individual'] as const;

/** Elements that may hold the encounter reference. */
const ENCOUNTER_ELEMENTS = ['encounter', 'context.encounter.0', 'context'] as const;

export interface EnvelopeResult {
  envelope: NormalizedResource;
  /** Data-quality issues discovered while building the envelope. */
  issues: string[];
}

/**
 * Extracts the subject, encounter, effective date and code that every resource
 * type shares, and records what was missing.
 *
 * Issues are returned separately from the envelope so a type-specific
 * normalizer can add its own before they are merged onto the record.
 */
export function buildEnvelope(raw: JsonObject, resourceType: string, id: string): EnvelopeResult {
  const issues: string[] = [];

  let patientId: string | undefined;
  for (const element of SUBJECT_ELEMENTS) {
    const candidate = path(raw, ...element.split('.'));
    if (candidate === undefined) continue;
    patientId = resolvePatientId(candidate);
    if (patientId) break;
    // A subject element exists but does not resolve to a local Patient id.
    issues.push(`unresolvable-subject:${element}`);
    break;
  }
  if (!patientId && issues.length === 0) issues.push('missing-subject');

  let encounterId: string | undefined;
  for (const element of ENCOUNTER_ELEMENTS) {
    const candidate = path(raw, ...element.split('.'));
    if (candidate === undefined) continue;
    encounterId = resolveLocalId(candidate, 'Encounter');
    if (encounterId) break;
  }

  const elements = EFFECTIVE_DATE_ELEMENTS[resourceType] ?? GENERIC_DATE_ELEMENTS;
  const effective = pickEffectiveDate(raw, elements);
  if (!effective) issues.push('missing-date');

  let code: ReturnType<typeof firstConcept>;
  for (const element of CODE_ELEMENTS[resourceType] ?? DEFAULT_CODE_ELEMENTS) {
    code = firstConcept(path(raw, ...element.split('.')));
    if (code) break;
  }
  if (!code) issues.push('missing-code');

  const envelope: NormalizedResource = compact({
    id,
    resourceType,
    ref: `${resourceType}/${id}`,
    patientId,
    encounterId,
    status: str(path(raw, 'status')),
    code,
    categories: parseConcepts(path(raw, 'category')),
    effective: effective?.date,
    effectiveSource: effective?.source,
  });

  return { envelope, issues };
}
