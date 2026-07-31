/**
 * The wire model for eligibility.
 *
 * Two rules shape every type in this file.
 *
 * 1. **A determination is never a bare word.** `eligible` on its own is an
 *    assertion; `eligible` next to the requirement findings that produced it,
 *    each carrying the FHIR resource ids it was decided from, is a reviewable
 *    claim. So `EligibilityAssessment` always ships its full working.
 *
 * 2. **`unknown` must say what is missing.** Part C requires it explicitly, and
 *    it is also the only way the cohort report can aggregate anything useful.
 *    Every unknown carries a machine-readable `UnknownReason` *and* a sentence
 *    a reviewer can act on, so the UI never has to invent the explanation.
 *
 * These shapes are also the deterministic floor Part D sits on: the AI layer is
 * handed an `EligibilityAssessment` and may only describe it. Its `checklist`
 * maps one-to-one onto `requirements`, and its evidence refs must be a subset of
 * the refs already present here.
 */
import type { DateInfo } from '../query/dto.js';

/** The three mutually exclusive outcomes Part C requires. */
export type Determination = 'eligible' | 'not-eligible' | 'unknown';

/**
 * Per-requirement outcome.
 *
 * `not-applicable` is separate from `met` on purpose: a patient with a BMI of
 * 44 does not need a comorbidity, and recording that as "met" would claim the
 * record contains evidence it may not contain.
 */
export type RequirementStatus = 'met' | 'not-met' | 'unknown' | 'not-applicable';

export type RequirementId =
  | 'bmi-threshold'
  | 'comorbidity'
  | 'weight-loss-attempts'
  | 'psychological-evaluation';

/**
 * Why something could not be determined.
 *
 * A closed union rather than free text: the cohort report groups on these, and
 * "breakdown of top reasons for unknown status" is only meaningful if the
 * reasons are a fixed vocabulary rather than a sentence that varies per patient.
 */
export type UnknownReason =
  /** No Observation with the policy's BMI LOINC code exists for this patient. */
  | 'no-bmi-recorded'
  /** A BMI exists, but the most recent one predates the lookback window. */
  | 'bmi-outside-lookback'
  /** A BMI observation exists but carries no numeric value (or an odd unit). */
  | 'bmi-value-unusable'
  /** BMI is in the 35–40 band, where a comorbidity is required, and none is coded. */
  | 'no-comorbidity-recorded'
  /** No accepted evidence of a prior weight-loss attempt. */
  | 'no-weight-loss-documentation'
  /** No accepted psychological evaluation. */
  | 'no-psychological-evaluation';

/** One FHIR resource cited as evidence, in the citation format Part D reuses. */
export interface EvidenceItem {
  /** `ResourceType/id` — resolvable through `GET /api/resources/:type/:id`. */
  ref: string;
  id: string;
  resourceType: string;
  /** Best human label for the resource: its code text, else the coding display. */
  display: string | null;
  date: DateInfo | null;
  /** The `(system, code)` that matched, so the match itself is auditable. */
  matchedCode: { system: string; code: string; display: string };
  /** Present when a value was part of the decision, e.g. `41.7 kg/m2`. */
  value: string | null;
  /** Why this evidence is insufficient, on `relatedEvidence` items only. */
  caveat?: string;
}

/** One line of the deterministic checklist. */
export interface RequirementFinding {
  id: RequirementId;
  label: string;
  status: RequirementStatus;
  /** One sentence stating what was found or not found, and why that is the status. */
  rationale: string;
  /** Resources that satisfied the requirement. Empty unless `status` is `met`. */
  evidence: EvidenceItem[];
  /**
   * Clinically adjacent resources that did *not* satisfy it.
   *
   * Capped, with `relatedEvidenceTotal` giving the true count, so a patient with
   * 40 depression screens produces a readable finding rather than a wall.
   */
  relatedEvidence: EvidenceItem[];
  relatedEvidenceTotal: number;
  /** Set exactly when `status` is `unknown`. */
  gap: UnknownReason | null;
}

/** The policy parameters an assessment was produced under. */
export interface PolicySummary {
  id: string;
  version: string;
  label: string;
  bmiSoleThreshold: number;
  bmiWithComorbidityThreshold: number;
  observationLookbackMonths: number;
  /** The date the assessment was made as of, `YYYY-MM-DD`. */
  asOf: string;
  /** How `asOf` was chosen — the caller's value, or the store's own data horizon. */
  asOfSource: 'requested' | 'store-latest-clinical-date' | 'clock';
  /** Start of the BMI lookback window, `YYYY-MM-DD`. */
  lookbackStart: string;
}

export interface EligibilityAssessment {
  patientId: string;
  /** `Patient/id`. */
  patientRef: string;
  policy: PolicySummary;
  determination: Determination;
  /** One sentence stating the determination and the single fact that drove it. */
  rationale: string;
  /** The full checklist, always all four requirements, in reviewing order. */
  requirements: RequirementFinding[];
  /**
   * Every gap standing between this patient and a determination, ordered as a
   * reviewer should chase them. Empty when the determination is not `unknown`.
   */
  unknownReasons: { reason: UnknownReason; label: string; detail: string }[];
}

/** One row of the cohort category breakdown. */
export interface CohortCategory {
  determination: Determination;
  count: number;
  /** Share of the whole cohort, 0–100, rounded to one decimal place. */
  percent: number;
}

/** One row of the "top reasons for unknown" breakdown. */
export interface CohortUnknownReason {
  reason: UnknownReason;
  label: string;
  /** Patients whose assessment carries this reason. Rows overlap by design. */
  patients: number;
  /** Share of *unknown* patients, 0–100. */
  percentOfUnknown: number;
  /** Share of the whole cohort, 0–100. */
  percentOfCohort: number;
}

/**
 * Patients grouped by their exact set of gaps.
 *
 * The per-reason breakdown above overlaps — one patient missing both documents
 * appears in two rows — so it answers "how common is this gap" but not "what
 * would it take to clear a patient". This answers the second: a combination of
 * one reason is one document away from a determination.
 */
export interface CohortUnknownCombination {
  reasons: UnknownReason[];
  patients: number;
  percentOfUnknown: number;
}

/** How far each policy code set actually reaches into this store. */
export interface PolicyCodeCoverage {
  setId: string;
  system: string;
  code: string;
  display: string;
  /** Distinct patients with at least one resource carrying this code. */
  patients: number;
  /** Resources carrying this code, across the whole store. */
  resources: number;
}

/** Context a reader needs to interpret the numbers above without re-querying. */
export interface CohortContext {
  /** Patients with at least one BMI observation, at any date. */
  patientsWithAnyBmi: number;
  /** Patients whose most recent usable BMI falls inside the lookback window. */
  patientsWithBmiInWindow: number;
  /** Latest BMI ≥ the sole threshold, inside the window. */
  patientsMeetingBmiSoleThreshold: number;
  /** Latest BMI in the 35–40 band, inside the window, with a coded comorbidity. */
  patientsMeetingBmiWithComorbidity: number;
  /** Latest BMI in the 35–40 band, inside the window, with no coded comorbidity. */
  patientsInBmiBandWithoutComorbidity: number;
  patientsWithWeightLossDocumentation: number;
  patientsWithPsychEvaluation: number;
  /** Patients satisfying both documentation requirements. */
  patientsWithBothDocuments: number;
  /** Deceased patients in the cohort — assessed like any other, but worth stating. */
  deceasedPatients: number;
  /** The newest clinical date anywhere in the store, `YYYY-MM-DD`. */
  storeLatestClinicalDate: string | null;
}

export interface CohortReport {
  policy: PolicySummary;
  /** Every patient with a Patient resource in the store. */
  totalPatients: number;
  categories: CohortCategory[];
  /** Descending by patient count. Rows overlap; see `unknownCombinations`. */
  unknownReasons: CohortUnknownReason[];
  /** Descending by patient count. Rows are mutually exclusive. */
  unknownCombinations: CohortUnknownCombination[];
  context: CohortContext;
  codeCoverage: PolicyCodeCoverage[];
  /**
   * Policy codes that matched no resource in this store.
   *
   * Stated rather than silently absent: a documentation requirement nothing can
   * satisfy is a property of the export, and a report that does not say so
   * invites the reader to conclude the patients failed it.
   */
  unmatchedPolicyCodes: { setId: string; system: string; code: string; display: string }[];
  /** Patients in the store whose resources reference them but carry no Patient resource. */
  danglingSubjectPatients: number;
  computeMs: number;
}
