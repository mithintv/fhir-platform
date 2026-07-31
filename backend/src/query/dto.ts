/**
 * The wire model — every shape the HTTP API returns, and the only thing the
 * frontend is allowed to know about the store.
 *
 * Design notes:
 * - "Missing data must be explicit" is a Part B requirement, so absence is
 *   modelled as a *value* here rather than as an optional field. `Age` is a
 *   tagged union with an `unknown` arm carrying a reason; `KeyObservation` has
 *   an `absent` arm. A component rendering one of these cannot silently produce
 *   an empty cell — it has to handle the arm, and the arm names the gap.
 * - Optional fields are still used where absence is genuinely uninteresting
 *   (a middle name, a postal code). The rule is: if a reviewer would make a
 *   different decision knowing the field was absent, it gets an explicit arm.
 * - Every clinical fact carries `ref` (`ResourceType/id`). That is the
 *   provenance the UI shows on each timeline row, and the citation format
 *   Part D's grounding check resolves against.
 */

/** A FHIR date kept verbatim, with the precision actually recorded. */
export interface DateInfo {
  /** The original FHIR string: `2013`, `2013-07`, or `2013-07-20T20:02:28-03:00`. */
  value: string;
  /** Epoch millis for the start of the period the string denotes. */
  sortKey: number;
  precision: 'year' | 'month' | 'day' | 'time';
}

/**
 * Age, with absence and death both modelled explicitly.
 *
 * A dead patient's age is not "their age today", and a patient with no
 * birthDate has no age at all — collapsing either into a plain number would
 * make the UI assert something the record does not say.
 */
export type Age =
  | { kind: 'living'; years: number; asOf: string }
  | { kind: 'at-death'; years: number; diedOn: string }
  | { kind: 'unknown'; reason: 'no-birth-date' | 'died-before-birth-date' | 'birth-date-in-future' };

/** One row in the patient selector. */
export interface PatientListItem {
  id: string;
  /** `null` when the Patient resource carried no usable name. */
  name: string | null;
  gender: string | null;
  birthDate: string | null;
  deceased: boolean;
}

export interface PatientSearchResult {
  /** Patients matching the query — the whole match count, not the page size. */
  total: number;
  items: PatientListItem[];
  limit: number;
  offset: number;
}

/** Demographics, straight off the Patient resource. */
export interface PatientDemographics {
  id: string;
  ref: string;
  name: string | null;
  /** Administrative gender. Distinct from `birthSex`; both are shown. */
  gender: string | null;
  /** US Core birth-sex extension. */
  birthSex: string | null;
  birthDate: DateInfo | null;
  deceased: boolean;
  deceasedDate: DateInfo | null;
  maritalStatus: string | null;
  race: string | null;
  ethnicity: string | null;
  address: { city?: string; state?: string; postalCode?: string } | null;
  /** Normalization issues recorded during ingest, e.g. `missing-name`. */
  issues: string[];
}

/** A Condition on the snapshot. */
export interface ConditionEntry {
  ref: string;
  id: string;
  display: string | null;
  /** `active`, `resolved`, `remission`, … or `null` when not recorded. */
  clinicalStatus: string | null;
  verificationStatus: string | null;
  onset: DateInfo | null;
  recorded: DateInfo | null;
  /** Every coding on the Condition, so a reviewer can see the source code. */
  codings: { system?: string; code?: string; display?: string }[];
}

/** A Procedure on the snapshot. */
export interface ProcedureEntry {
  ref: string;
  id: string;
  display: string | null;
  status: string | null;
  performed: DateInfo | null;
  codings: { system?: string; code?: string; display?: string }[];
}

/** The metrics the snapshot always accounts for, present or not. */
export type ObservationMetric = 'bmi' | 'bloodPressure' | 'hba1c';

/** One reading of a key metric. `bloodPressure` uses `parts`, the rest `value`. */
export interface ObservationReading {
  ref: string;
  id: string;
  date: DateInfo | null;
  /** Rendered scalar value, e.g. `28.04 kg/m2`. Null for panel observations. */
  value: string | null;
  numeric: number | null;
  unit: string | null;
  /** Panel members — systolic/diastolic for a blood-pressure panel. */
  parts: { label: string; value: string }[];
  /** FHIR's explicit "why there is no value here", when the source said so. */
  dataAbsentReason: string | null;
}

/**
 * A key metric, always present in the response for every metric in the panel.
 *
 * The `absent` arm is why: a snapshot that simply omits BMI is
 * indistinguishable from one where BMI was never looked for.
 */
export type KeyObservation =
  | {
      kind: 'recorded';
      metric: ObservationMetric;
      label: string;
      /** LOINC code(s) this metric was matched on. */
      codes: string[];
      latest: ObservationReading;
      /** How many readings exist in total, for trend context. */
      count: number;
      earliest: DateInfo | null;
    }
  | {
      kind: 'absent';
      metric: ObservationMetric;
      label: string;
      codes: string[];
      /** Human-readable statement of what is missing and how it was looked for. */
      note: string;
    };

/** Counts of every resource type held for this patient. */
export interface ResourceMix {
  resourceType: string;
  count: number;
  /** Rows of this type with no usable date — they cannot be placed on a timeline. */
  undated: number;
}

export interface ClinicalSnapshot {
  patient: PatientDemographics;
  age: Age;
  /** Active conditions, most recent onset first. */
  activeConditions: ConditionEntry[];
  /** Conditions explicitly resolved or in remission — counted, not listed. */
  inactiveConditionCount: number;
  /** Conditions with no `clinicalStatus` at all: neither active nor resolved. */
  undeterminedConditions: ConditionEntry[];
  /** Most recent procedures, newest first. */
  recentProcedures: ProcedureEntry[];
  procedureCount: number;
  keyObservations: KeyObservation[];
  resourceMix: ResourceMix[];
}

export type TimelineResourceType = 'Observation' | 'Procedure';

export interface TimelineEntry {
  /** `ResourceType/id` — the source FHIR resource ID the brief asks to display. */
  ref: string;
  id: string;
  resourceType: TimelineResourceType;
  /** `null` when the resource carried no code element at all. */
  display: string | null;
  date: DateInfo | null;
  status: string | null;
  /** Rendered value summary, e.g. `141/92 mm[Hg]`. Null for procedures. */
  value: string | null;
  category: string | null;
  codings: { system?: string; code?: string; display?: string }[];
}

export interface TimelinePage {
  entries: TimelineEntry[];
  total: number;
  limit: number;
  offset: number;
  order: 'asc' | 'desc';
  /** Rows in scope that carry no usable date, so the UI can say so up front. */
  undated: number;
  /** Per-type totals in scope, for the filter chips. */
  countsByType: Record<TimelineResourceType, number>;
}

/**
 * Ingest provenance, so the UI can state which dataset it is showing and
 * whether the ingest that produced it passed its own integrity checks.
 */
export interface StoreMeta {
  patients: number;
  resources: number;
  /** Null for a store written before this key existed. */
  ingestedAt: string | null;
  verification: { name: string; expected: number; actual: number; ok: boolean }[];
}
