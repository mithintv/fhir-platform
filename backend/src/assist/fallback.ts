/**
 * The explanation the tool gives when the model does not get to speak.
 *
 * This is the safe-degradation path the brief requires, and it is deliberately
 * built as a `ModelDraft` rather than as a separate response shape. One
 * assembler (`assemble`) turns a draft plus an assessment into an
 * `AssistResult`, and it does not know or care whether the draft came from a
 * provider or from this file. Two consequences follow, both of them the point:
 *
 *  - A degraded response is *complete*. Same fields, same citations, same
 *    checklist — only `provenance` differs, and it names what failed. The UI
 *    never has to render an error where an explanation belongs.
 *  - The deterministic draft can be run through the same grounding checks the
 *    model's output faces, and there is a test that does exactly that. If the
 *    house's own prose could not pass its own rules, the rules would be
 *    describing an unreachable standard.
 *
 * The prose here is generated from the evidence rather than written by hand, so
 * every number in it is traceable to a resource by construction — which is what
 * makes that test pass rather than a coincidence.
 */
import type { EligibilityAssessment, UnknownReason } from '../eligibility/dto.js';
import type {
  AssistChecklistItem,
  AssistProvenance,
  AssistResult,
  AssistViolation,
  DegradeReason,
} from './dto.js';
import type { AssistContext, CitableResource } from './context.js';
import type { ModelClaim, ModelDraft } from './schema.js';

/**
 * What to do about each gap.
 *
 * A closed map over Part C's reason vocabulary, so a next step is a lookup
 * rather than a sentence someone generated. `no-psychological-evaluation`
 * produces the brief's own example next step, which is a coincidence worth
 * noticing: the useful thing to tell a reviewer about a missing document is
 * always "go and get it".
 */
export const NEXT_STEP: Record<UnknownReason, string> = {
  'no-bmi-recorded': 'Obtain a current BMI measurement (LOINC 39156-5) and record it as a numeric value.',
  'bmi-outside-lookback': 'Obtain a BMI measurement inside the lookback window; the most recent one on file predates it.',
  'bmi-value-unusable': 'Re-record the BMI with a numeric value in kg/m2; the observations on file carry none.',
  'no-comorbidity-recorded': 'Confirm whether a qualifying obesity-related comorbidity exists and code it, or record that none is present.',
  'no-weight-loss-documentation': 'Request documentation of prior weight-loss attempts.',
  'no-psychological-evaluation': 'Request documentation of psychological evaluation.',
};

/** Human wording for each degradation, for the banner a reviewer reads. */
const DEGRADE_DETAIL: Record<DegradeReason, string> = {
  'no-provider': 'No AI provider is configured, so this explanation is the deterministic one.',
  'model-error': 'The AI provider could not be reached, so this explanation is the deterministic one.',
  timeout: 'The AI provider did not answer in time, so this explanation is the deterministic one.',
  unparseable: 'The AI response did not match the required structure and was discarded.',
  'ungrounded-citation': 'The AI response cited evidence this assessment does not contain, and was discarded.',
  'hedged-claim': 'The AI response asserted something without evidence, and was discarded.',
  'conflict-resolved': 'The AI response treated evidence the policy marks insufficient as though it counted, and was discarded.',
  'contradicts-determination': 'The AI response asserted an outcome other than the deterministic one, and was discarded.',
  'incomplete-draft': 'The AI response was incomplete, and was discarded.',
};

const refsOf = (resources: CitableResource[]): string[] => resources.map((item) => item.ref);

/**
 * A condition's name, trimmed of the SNOMED suffix.
 *
 * "Essential hypertension (disorder)" reads as terminology; "essential
 * hypertension" reads as a sentence, and the ref beside it is what a reviewer
 * checks anyway.
 */
function shortName(resource: CitableResource): string {
  const label = resource.display ?? resource.ref;
  return label.replace(/\s*\((?:disorder|finding|procedure|regime\/therapy)\)\s*$/i, '').toLowerCase();
}

/** Keeps the one-line summary inside the bound the validator enforces. */
function truncate(text: string, limit = 200): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 2).trimEnd()}…`;
}

/**
 * A FHIR date at day precision.
 *
 * `2022-06-23T12:12:11-03:00` is the right thing to store and the wrong thing
 * to read in a sentence. Truncating is safe for the number-traceability check
 * because the shortened form's digits are a subset of the stored value's.
 */
function day(date: string | null): string | null {
  if (date === null) return null;
  return /^\d{4}-\d{2}-\d{2}T/.test(date) ? date.slice(0, 10) : date;
}

/** `a`, `a and b`, `a, b and c` — a list that reads as prose. */
function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
}

function requirementOf(context: AssistContext, id: string) {
  return context.requirements.find((entry) => entry.requirementId === id);
}

/**
 * Composes the deterministic draft.
 *
 * Kept to at most four claims and short sentences so it satisfies the same
 * bounds a model draft has to satisfy.
 */
export function deterministicDraft(context: AssistContext): ModelDraft {
  // Built as clauses of one sentence rather than as sentences, because the
  // summary is a one-line orientation — "52-year-old female with a BMI of 41.7"
  // — and not a report. Everything a reviewer needs beyond that line is in the
  // checklist immediately below it.
  const evidence: string[] = [context.demographics.ref];
  let unknown = context.demographics.ageYears === null;

  const subject = [
    context.demographics.agePhrase,
    context.demographics.gender ?? 'patient of unrecorded gender',
  ].join(' ');

  // A flat list of facts rather than nested clauses, so the serial join reads
  // as one sentence: "…with a BMI of 41.7, essential hypertension and sleep
  // apnea" instead of "…with a BMI of 41.7 and hypertension and sleep apnea".
  const facts: string[] = [];

  const bmi = requirementOf(context, 'bmi-threshold');
  if (bmi !== undefined) {
    const reading = bmi.evidence[0] ?? bmi.relatedEvidence[0];
    if (reading === undefined) {
      facts.push('no BMI on file');
      unknown = true;
    } else {
      evidence.push(reading.ref);
      const on = day(reading.date);
      // A stale reading and a current one are the same clause until the reason
      // it cannot be used is in it — the difference between a reviewer reading
      // "BMI 26" as a decision and reading it as a gap.
      const qualifier =
        bmi.gap === 'bmi-outside-lookback'
          ? ` from ${on ?? 'an undated record'}, outside the ${context.policy.observationLookbackMonths}-month window`
          : bmi.gap === 'bmi-value-unusable'
            ? ' recorded without a usable value'
            : on === null
              ? ''
              : ` recorded ${on}`;
      facts.push(`a BMI of ${reading.value ?? 'unknown value'}${qualifier}`);
      if (bmi.status === 'unknown') unknown = true;
    }
  }

  const comorbidity = requirementOf(context, 'comorbidity');
  if (comorbidity !== undefined && comorbidity.evidence.length > 0) {
    const named = comorbidity.evidence.slice(0, 2);
    evidence.push(...refsOf(named));
    facts.push(...named.map(shortName));
    const extra = comorbidity.evidence.length - named.length;
    if (extra > 0) facts.push(`${extra} further coded comorbidity`);
  } else if (comorbidity !== undefined && comorbidity.status === 'unknown') {
    facts.push('no coded comorbidity');
    unknown = true;
  }

  const text = facts.length === 0 ? `${subject}.` : `${subject} with ${joinPhrases(facts)}.`;

  return {
    summary: { text: truncate(text), evidence, unknown },
    requirementNotes: context.requirements.map((requirement) => ({
      requirementId: requirement.requirementId as ModelDraft['requirementNotes'][number]['requirementId'],
      note: requirement.rationale,
    })),
    nextSteps: [],
  };
}

/**
 * Builds the final response from a draft and the assessment.
 *
 * The three fields the model may never touch — the determination, each
 * requirement's status, and each requirement's citations — are read off the
 * assessment here, at the last moment, so there is exactly one place in the
 * codebase where they could have been taken from anywhere else.
 */
export function assemble(
  assessment: EligibilityAssessment,
  context: AssistContext,
  draft: ModelDraft,
  provenance: AssistProvenance,
): AssistResult {
  const notes = new Map(draft.requirementNotes.map((entry) => [entry.requirementId, entry.note]));

  const checklist: AssistChecklistItem[] = assessment.requirements.map((finding) => ({
    requirementId: finding.id,
    requirement: finding.label,
    status: finding.status,
    evidence: finding.evidence.map((item) => item.ref),
    // Falling back per line rather than failing: a draft that reached this
    // point passed validation, and validation already requires a note for every
    // requirement — this is the belt to that braces.
    note: notes.get(finding.id) ?? finding.rationale,
  }));

  // Steps are keyed off the deterministic gaps, not off the draft's opinion of
  // what is missing. The model chooses the wording; Part C chooses the list.
  const modelSteps = new Map(
    draft.nextSteps
      .filter((step) => step.requirementId !== null)
      .map((step) => [step.requirementId as string, step.text]),
  );
  const generalSteps = draft.nextSteps.filter((step) => step.requirementId === null);

  const recommendedNextSteps = assessment.unknownReasons.map((entry) => {
    const owner = assessment.requirements.find((finding) => finding.gap === entry.reason);
    const supplied = owner === undefined ? undefined : modelSteps.get(owner.id);
    return supplied ?? NEXT_STEP[entry.reason];
  });
  recommendedNextSteps.push(...generalSteps.map((step) => step.text));

  return {
    patientId: assessment.patientId,
    patientRef: assessment.patientRef,
    clinicalSummary: draft.summary.text.trim(),
    clinicalSummaryEvidence: draft.summary.evidence,
    eligibilityAssessment: assessment.determination,
    checklist,
    recommendedNextSteps,
    provenance,
  };
}

/** The complete degraded response, with the reason it is degraded attached. */
export function deterministicResult(
  assessment: EligibilityAssessment,
  context: AssistContext,
  reason: DegradeReason,
  violations: AssistViolation[] = [],
  detail?: string,
): AssistResult {
  return assemble(assessment, context, deterministicDraft(context), {
    kind: 'deterministic',
    reason,
    detail: detail ?? DEGRADE_DETAIL[reason],
    violations,
    policyVersion: assessment.policy.version,
    asOf: assessment.policy.asOf,
  });
}
