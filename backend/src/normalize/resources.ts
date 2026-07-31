/**
 * Per-resource-type normalizers.
 *
 * Each normalizer takes the shared envelope and adds only the fields the
 * prior-auth review tool actually needs. Anything without a dedicated
 * normalizer falls back to the envelope alone, so an unexpected resource type
 * in the export still lands on the patient timeline rather than being dropped.
 */
import type {
  NormalizedAllergyIntolerance,
  NormalizedCondition,
  NormalizedDocumentReference,
  NormalizedEncounter,
  NormalizedMedicationRequest,
  NormalizedObservation,
  NormalizedObservationComponent,
  NormalizedProcedure,
  NormalizedResource,
} from '../model/types.js';
import { parseCoding, parseConcept, parseConcepts, parseValue } from '../fhir/concept.js';
import { parseDate, parsePeriod } from '../fhir/dates.js';
import { parseReference } from '../fhir/reference.js';
import { compact, num, objArr, path, str } from '../fhir/safe.js';
import type { Json, JsonObject } from '../fhir/safe.js';

export interface NormalizeOptions {
  /** Decode inline text attachments on DocumentReference. */
  includeNoteText: boolean;
  /** Truncate decoded note text to this many characters. */
  maxNoteChars: number;
}

/** Notes on, truncated at 8k characters — enough for a full clinical note. */
export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = {
  includeNoteText: true,
  maxNoteChars: 8_000,
};

/** Adds type-specific fields to an already-built envelope. */
export type ResourceNormalizer = (
  raw: JsonObject,
  envelope: NormalizedResource,
  options: NormalizeOptions,
) => NormalizedResource;

/** `clinicalStatus`/`verificationStatus` are CodeableConcepts; we want the code. */
function statusCode(value: Json): string | undefined {
  return str(path(value, 'coding', '0', 'code')) ?? str(path(value, 'text'));
}

/**
 * Observation: the `value[x]`, plus `component[]` for panels.
 *
 * Components matter disproportionately — blood pressure carries its systolic and
 * diastolic numbers there and has no top-level value at all, so an Observation
 * normalizer that ignored them would lose every BP reading in the export.
 */
const normalizeObservation: ResourceNormalizer = (raw, envelope) => {
  const components: NormalizedObservationComponent[] = [];
  for (const component of objArr(path(raw, 'component'))) {
    const normalized = compact({
      code: parseConcept(path(component, 'code')),
      value: parseValue(component),
      dataAbsentReason: statusCode(path(component, 'dataAbsentReason')),
    });
    if (normalized.code || normalized.value || normalized.dataAbsentReason) components.push(normalized);
  }

  const referenceRange = objArr(path(raw, 'referenceRange'))
    .map((range) =>
      compact({
        low: num(path(range, 'low', 'value')),
        high: num(path(range, 'high', 'value')),
        unit: str(path(range, 'low', 'unit')) ?? str(path(range, 'high', 'unit')),
        text: str(path(range, 'text')),
      }),
    )
    .filter((range) => Object.keys(range).length > 0);

  const observation: NormalizedObservation = compact({
    ...envelope,
    resourceType: 'Observation',
    value: parseValue(raw),
    components: components.length > 0 ? components : undefined,
    dataAbsentReason: statusCode(path(raw, 'dataAbsentReason')),
    interpretation: parseConcepts(path(raw, 'interpretation')),
    referenceRange: referenceRange.length > 0 ? referenceRange : undefined,
  });

  // A vital sign with neither a value nor an explicit absence reason is a real
  // data-quality signal for Part C, so surface it rather than leaving a hole.
  if (!observation.value && !observation.components && !observation.dataAbsentReason) {
    observation.issues = [...(observation.issues ?? []), 'missing-value'];
  }
  return observation;
};

/**
 * Condition: status codes plus the three dates that mean different things —
 * when it began, when it resolved, and when someone wrote it down.
 */
const normalizeCondition: ResourceNormalizer = (raw, envelope) => {
  const condition: NormalizedCondition = compact({
    ...envelope,
    resourceType: 'Condition',
    clinicalStatus: statusCode(path(raw, 'clinicalStatus')),
    verificationStatus: statusCode(path(raw, 'verificationStatus')),
    onset: parseDate(path(raw, 'onsetDateTime')) ?? parsePeriod(path(raw, 'onsetPeriod')).start,
    abatement: parseDate(path(raw, 'abatementDateTime')) ?? parsePeriod(path(raw, 'abatementPeriod')).start,
    recordedDate: parseDate(path(raw, 'recordedDate')),
  });
  return condition;
};

/** Procedure: when it was performed, why, and on what body site. */
const normalizeProcedure: ResourceNormalizer = (raw, envelope) => {
  const period = parsePeriod(path(raw, 'performedPeriod'));
  const procedure: NormalizedProcedure = compact({
    ...envelope,
    resourceType: 'Procedure',
    performedStart: parseDate(path(raw, 'performedDateTime')) ?? period.start,
    performedEnd: period.end,
    reasons: parseConcepts(path(raw, 'reasonCode')),
    bodySites: parseConcepts(path(raw, 'bodySite')),
  });
  return procedure;
};

/**
 * Encounter: class (inpatient/outpatient/emergency) and the visit period, which
 * together establish the care setting other resources hang off.
 */
const normalizeEncounter: ResourceNormalizer = (raw, envelope) => {
  const period = parsePeriod(path(raw, 'period'));
  const encounter: NormalizedEncounter = compact({
    ...envelope,
    resourceType: 'Encounter',
    class: parseCoding(path(raw, 'class')),
    types: parseConcepts(path(raw, 'type')),
    periodStart: period.start,
    periodEnd: period.end,
    reasons: parseConcepts(path(raw, 'reasonCode')),
  });
  return encounter;
};

/**
 * Decodes an inline attachment when it is base64-encoded text.
 *
 * Bulk exports carry clinical notes here; they are the only place documentation
 * requirements (weight-loss attempts, psychological evaluation) can be
 * evidenced. Binary attachments are counted but not decoded.
 */
function decodeAttachment(
  attachment: Json,
  options: NormalizeOptions,
): { contentType?: string; text?: string; bytes?: number } {
  const contentType = str(path(attachment, 'contentType'));
  const data = str(path(attachment, 'data'));
  if (!data) return compact({ contentType });

  const bytes = Math.floor((data.length * 3) / 4);
  if (!options.includeNoteText) return compact({ contentType, bytes });

  const isText = !contentType || /^text\/|json|xml/i.test(contentType);
  if (!isText) return compact({ contentType, bytes });

  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8');
    const text = decoded.length > options.maxNoteChars ? `${decoded.slice(0, options.maxNoteChars)}…` : decoded;
    return compact({ contentType, bytes, text: str(text) });
  } catch {
    return compact({ contentType, bytes });
  }
}

/**
 * DocumentReference: authorship plus the first content entry that yields either
 * decoded text or a content type — the note body itself lives in `content[]`.
 */
const normalizeDocumentReference: ResourceNormalizer = (raw, envelope, options) => {
  const contents = objArr(path(raw, 'content'));
  const decoded = contents
    .map((content) => decodeAttachment(path(content, 'attachment'), options))
    .find((entry) => entry.text !== undefined || entry.contentType !== undefined);

  const document: NormalizedDocumentReference = compact({
    ...envelope,
    resourceType: 'DocumentReference',
    docStatus: str(path(raw, 'docStatus')),
    type: parseConcept(path(raw, 'type')),
    author: objArr(path(raw, 'author'))
      .map((author) => parseReference(author))
      .filter((reference): reference is NonNullable<typeof reference> => reference !== undefined),
    custodian: parseReference(path(raw, 'custodian')),
    contentType: decoded?.contentType,
    text: decoded?.text,
    attachmentBytes: decoded?.bytes,
  });
  if (document.author?.length === 0) delete document.author;
  return document;
};

/**
 * MedicationRequest: the drug, which FHIR allows to be either an inline
 * CodeableConcept or a reference to a Medication resource. When only a
 * reference is present its display text is used, since the export does not
 * include the referenced Medication.
 */
const normalizeMedicationRequest: ResourceNormalizer = (raw, envelope) => {
  const medicationReference = parseReference(path(raw, 'medicationReference'));
  const request: NormalizedMedicationRequest = compact({
    ...envelope,
    resourceType: 'MedicationRequest',
    intent: str(path(raw, 'intent')),
    medication:
      parseConcept(path(raw, 'medicationCodeableConcept')) ??
      (medicationReference?.display ? { text: medicationReference.display, codings: [] } : undefined),
    authoredOn: parseDate(path(raw, 'authoredOn')),
    reasons: parseConcepts(path(raw, 'reasonCode')),
    dosageText: str(path(raw, 'dosageInstruction', '0', 'text')),
  });
  return request;
};

/** AllergyIntolerance: whether it is still active, confirmed, and how severe. */
const normalizeAllergyIntolerance: ResourceNormalizer = (raw, envelope) => {
  const allergy: NormalizedAllergyIntolerance = compact({
    ...envelope,
    resourceType: 'AllergyIntolerance',
    clinicalStatus: statusCode(path(raw, 'clinicalStatus')),
    verificationStatus: statusCode(path(raw, 'verificationStatus')),
    criticality: str(path(raw, 'criticality')),
  });
  return allergy;
};

/**
 * Lookup by FHIR resource type. A type absent from this map is not an error —
 * it keeps the envelope and still appears on the timeline.
 */
export const RESOURCE_NORMALIZERS: Record<string, ResourceNormalizer> = {
  Observation: normalizeObservation,
  Condition: normalizeCondition,
  Procedure: normalizeProcedure,
  Encounter: normalizeEncounter,
  DocumentReference: normalizeDocumentReference,
  MedicationRequest: normalizeMedicationRequest,
  AllergyIntolerance: normalizeAllergyIntolerance,
};
