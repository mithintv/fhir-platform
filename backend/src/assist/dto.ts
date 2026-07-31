/**
 * The wire model for AI Assist (Part D).
 *
 * One idea shapes every type here: **the model is never asked for a fact it
 * could get wrong.**
 *
 * The brief requires the assist output to carry a determination, a per-
 * requirement status, and the FHIR resource ids each requirement was decided
 * from. All three already exist — Part C computed them. Asking a model to
 * reproduce them creates a way for it to be wrong about something that was
 * already right, and turns "the AI must not override the deterministic logic"
 * into a prompt instruction rather than a property of the system.
 *
 * So the split is structural. `AssistResult.eligibilityAssessment`, every
 * `checklist[].status`, and every `checklist[].evidence` are copied verbatim
 * from the `EligibilityAssessment`. The model contributes exactly three things,
 * all of them prose: the clinical summary, one plain-language note per
 * requirement, and the recommended next steps. Those fields are the only ones
 * in its output schema, so a model that tried to change a determination would
 * have nowhere to put it.
 *
 * What is left for the model to get wrong is what it *says*, and that is what
 * `validate.ts` checks: every claim either cites resource ids drawn from the
 * assessment or is explicitly flagged `unknown`.
 *
 * `provenance` is not decoration. Every response is a complete, valid result —
 * including the ones where the model failed — so without it a reviewer could
 * not tell a model-authored explanation from the deterministic fallback. It is
 * a required field, and its `deterministic` arm names the specific failure.
 */
import type { Determination, RequirementId, RequirementStatus } from '../eligibility/dto.js';

/** One line of the assist checklist. Only `note` comes from the model. */
export interface AssistChecklistItem {
  requirementId: RequirementId;
  /** Part C's label, e.g. `BMI threshold`. */
  requirement: string;
  /** Part C's status. Never model-authored. */
  status: RequirementStatus;
  /** Part C's citations for this requirement. Never model-authored. */
  evidence: string[];
  /** Plain-language explanation of the status. Model-authored, or Part C's own
   * rationale when the response is deterministic. */
  note: string;
}

/**
 * Why a response fell back to the deterministic explanation.
 *
 * A closed union rather than a boolean, because "the model was not configured"
 * and "the model cited a resource this patient does not have" are very
 * different things for a reviewer to know, and only one of them is a reason to
 * distrust the tool.
 */
export type DegradeReason =
  /** No model provider is configured, or its credentials are missing. */
  | 'no-provider'
  /** The provider call failed: transport, rate limit, server error, refusal. */
  | 'model-error'
  /** The provider did not answer inside the deadline. */
  | 'timeout'
  /** The response was not JSON, or not the shape the schema requires. */
  | 'unparseable'
  /** A claim cited a resource outside the assessment, or asserted something uncited. */
  | 'ungrounded-citation'
  /** Hedging language without evidence — "likely", "probably", "suggests". */
  | 'hedged-claim'
  /** Evidence Part C marked insufficient was written up as if it counted. */
  | 'conflict-resolved'
  /** The prose asserted an outcome other than the deterministic determination. */
  | 'contradicts-determination'
  /** Structurally valid but incomplete: missing requirements, empty summary, out of bounds. */
  | 'incomplete-draft';

/** One failed grounding check, in the reviewer's words rather than a code. */
export interface AssistViolation {
  reason: DegradeReason;
  /** Which part of the draft failed, e.g. `summary[1]` or `nextSteps[0]`. */
  at: string;
  message: string;
}

export type AssistProvenance =
  | {
      kind: 'model';
      /** Provider id, e.g. `anthropic` or `stub`. */
      provider: string;
      /** Model id, or the stub's name. */
      model: string;
      /** Policy the underlying assessment was produced under. */
      policyVersion: string;
      asOf: string;
    }
  | {
      kind: 'deterministic';
      reason: DegradeReason;
      /** One sentence a reviewer can read, naming what failed. */
      detail: string;
      /** Every check that failed, when the failure was a grounding check. */
      violations: AssistViolation[];
      policyVersion: string;
      asOf: string;
    };

/**
 * The assist response.
 *
 * The four fields the brief names are all present and carry the brief's
 * meanings; `clinicalSummaryClaims` and `provenance` are additions, because a
 * paragraph whose citations have been flattened away cannot be checked by the
 * person reading it, and an explanation that does not say where it came from is
 * indistinguishable from one that was made up.
 */
export interface AssistResult {
  patientId: string;
  patientRef: string;
  /**
   * One sentence orienting a reviewer, in the shape of the brief's example:
   * "52-year-old female with long-standing morbid obesity and hypertension."
   */
  clinicalSummary: string;
  /**
   * The `ResourceType/id` refs backing that sentence.
   *
   * Not in the brief's example output, and required anyway: the brief's first
   * hard constraint is that every factual claim references resource ids, and a
   * summary whose citations have been dropped is a claim the reader cannot
   * check. Empty only when the sentence is entirely about what is missing.
   */
  clinicalSummaryEvidence: string[];
  /** Part C's determination, verbatim. The model cannot emit this field. */
  eligibilityAssessment: Determination;
  checklist: AssistChecklistItem[];
  recommendedNextSteps: string[];
  provenance: AssistProvenance;
}
