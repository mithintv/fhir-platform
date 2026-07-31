/**
 * The internal, normalized model.
 *
 * Design notes:
 * - Every field that FHIR permits to be absent is optional here. Nothing is
 *   defaulted to a fake value (no `0`, no `"unknown"` strings) so downstream
 *   consumers can distinguish "absent" from "recorded as zero". Part C's
 *   eligibility logic depends on that distinction.
 * - Resources share a common envelope (`NormalizedResource`) so the timeline
 *   view and the generic fallback normalizer can treat them uniformly.
 * - Dates are kept as the original FHIR string (ISO 8601, possibly partial such
 *   as `2013-07` or `2013`) plus a derived sortable millisecond timestamp.
 */

/** A FHIR date/dateTime/instant, kept verbatim, with a derived sort key. */
export interface NormalizedDate {
  /** Original string exactly as it appeared in the source resource. */
  value: string;
  /** Epoch millis for the *start* of the period the string denotes. */
  sortKey: number;
  /** Precision actually present in the source. */
  precision: 'year' | 'month' | 'day' | 'time';
}

/** A single coding, flattened out of a CodeableConcept. */
export interface NormalizedCoding {
  system?: string;
  code?: string;
  display?: string;
}

/** A CodeableConcept reduced to what a reviewer actually needs to see. */
export interface NormalizedConcept {
  /** Preferred human label: `text`, else first coding `display`, else code. */
  text?: string;
  /** All codings, preserved so code-based logic can match any system. */
  codings: NormalizedCoding[];
}

/** How a `Reference` pointed at its target. */
export type ReferenceForm =
  | 'relative' // "Patient/123"
  | 'absolute' // "https://example.org/fhir/Patient/123"
  | 'urn-uuid' // "urn:uuid:..."
  | 'logical' // "Patient?identifier=system|value" or a bare Reference.identifier
  | 'contained' // "#contained-1"
  | 'unknown';

export interface NormalizedReference {
  /** The raw `Reference.reference` string, when there was one. */
  raw?: string;
  form: ReferenceForm;
  /** Target resource type, from the reference string or `Reference.type`. */
  resourceType?: string;
  /** Target logical id — only present for resolvable literal references. */
  id?: string;
  /** Business identifier, for logical references. */
  identifier?: { system?: string; value?: string };
  display?: string;
}

/** Fields shared by every non-Patient resource we keep. */
export interface NormalizedResource {
  /** FHIR logical id. */
  id: string;
  resourceType: string;
  /** `ResourceType/id` — the citation format used by the AI layer in Part D. */
  ref: string;
  /** Resolved subject patient id, or undefined if the subject was unresolvable. */
  patientId?: string;
  /** Resolved encounter id, when the resource is tied to an encounter. */
  encounterId?: string;
  status?: string;
  code?: NormalizedConcept;
  categories?: NormalizedConcept[];
  /**
   * The single date used to place this resource on the timeline, chosen from
   * the type-appropriate FHIR element (see `pickEffectiveDate`).
   */
  effective?: NormalizedDate;
  /** Which FHIR element `effective` came from, e.g. `performedPeriod.start`. */
  effectiveSource?: string;
  /** Per-resource issues found while normalizing (missing code, bad date, ...). */
  issues?: string[];
}

export type ObservationValue =
  | { kind: 'quantity'; value?: number; unit?: string; system?: string; code?: string; comparator?: string }
  | { kind: 'codeable'; concept: NormalizedConcept }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; value: number }
  | { kind: 'ratio'; numerator?: number; denominator?: number; unit?: string }
  | { kind: 'range'; low?: number; high?: number; unit?: string }
  | { kind: 'datetime'; value: string }
  | { kind: 'period'; start?: string; end?: string }
  | { kind: 'unsupported'; element: string };

export interface NormalizedObservationComponent {
  code?: NormalizedConcept;
  value?: ObservationValue;
  dataAbsentReason?: string;
}

export interface NormalizedObservation extends NormalizedResource {
  resourceType: 'Observation';
  value?: ObservationValue;
  /** Panel members, e.g. systolic/diastolic inside a blood-pressure panel. */
  components?: NormalizedObservationComponent[];
  /** Set when FHIR explicitly says why a value is missing. */
  dataAbsentReason?: string;
  interpretation?: NormalizedConcept[];
  referenceRange?: { low?: number; high?: number; unit?: string; text?: string }[];
}

export interface NormalizedCondition extends NormalizedResource {
  resourceType: 'Condition';
  clinicalStatus?: string;
  verificationStatus?: string;
  onset?: NormalizedDate;
  abatement?: NormalizedDate;
  recordedDate?: NormalizedDate;
}

export interface NormalizedProcedure extends NormalizedResource {
  resourceType: 'Procedure';
  performedStart?: NormalizedDate;
  performedEnd?: NormalizedDate;
  reasons?: NormalizedConcept[];
  bodySites?: NormalizedConcept[];
}

export interface NormalizedEncounter extends NormalizedResource {
  resourceType: 'Encounter';
  class?: NormalizedCoding;
  types?: NormalizedConcept[];
  periodStart?: NormalizedDate;
  periodEnd?: NormalizedDate;
  reasons?: NormalizedConcept[];
}

export interface NormalizedDocumentReference extends NormalizedResource {
  resourceType: 'DocumentReference';
  docStatus?: string;
  type?: NormalizedConcept;
  author?: NormalizedReference[];
  custodian?: NormalizedReference;
  contentType?: string;
  /** Decoded plain-text note body, when the attachment was inline and textual. */
  text?: string;
  /** Byte length of the original attachment, even when the text is not kept. */
  attachmentBytes?: number;
}

export interface NormalizedMedicationRequest extends NormalizedResource {
  resourceType: 'MedicationRequest';
  intent?: string;
  medication?: NormalizedConcept;
  authoredOn?: NormalizedDate;
  reasons?: NormalizedConcept[];
  dosageText?: string;
}

export interface NormalizedAllergyIntolerance extends NormalizedResource {
  resourceType: 'AllergyIntolerance';
  clinicalStatus?: string;
  verificationStatus?: string;
  criticality?: string;
}

export interface NormalizedHumanName {
  text: string;
  family?: string;
  given?: string[];
  prefix?: string[];
  suffix?: string[];
  use?: string;
}

export interface NormalizedPatient {
  id: string;
  ref: string;
  /** Best display name; `undefined` when the record carried no usable name. */
  name?: NormalizedHumanName;
  /** All names, including maiden/nickname, for the patient search in Part B. */
  names: NormalizedHumanName[];
  gender?: string;
  birthDate?: NormalizedDate;
  deceased?: boolean;
  deceasedDate?: NormalizedDate;
  maritalStatus?: NormalizedConcept;
  /** US Core birth sex extension — distinct from administrative `gender`. */
  birthSex?: string;
  race?: string;
  ethnicity?: string;
  language?: string;
  address?: { line?: string[]; city?: string; state?: string; postalCode?: string; country?: string };
  identifiers: { system?: string; value?: string; type?: string }[];
  managingOrganization?: NormalizedReference;
  issues?: string[];
}
