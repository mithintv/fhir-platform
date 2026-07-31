/**
 * Public surface of the deterministic eligibility layer (Part C).
 *
 * Part D consumes exactly this and nothing deeper: an AI reviewer is handed an
 * `EligibilityAssessment` and may explain it, but the determination and the
 * evidence refs it is allowed to cite are both fixed before the model is
 * involved.
 */
export * from './dto.js';
export { BARIATRIC_POLICY } from './policy.js';
export type { CodeSet, CodeSetId, Policy, PolicyCode } from './policy.js';
export { assessCohort, assessPatient } from './cohort.js';
export type { CohortOptions } from './cohort.js';
export { evaluateEligibility, resolveAsOf, UNKNOWN_REASON_LABELS } from './evaluate.js';
export type { AsOfOptions } from './evaluate.js';
export {
  gatherCohortEvidence,
  gatherPatientEvidence,
  latestClinicalDate,
  resolveCodes,
} from './evidence.js';
export type { BmiReading, CodedHit, PatientEvidence, ResolvedCodes } from './evidence.js';
