/**
 * What the model is told, and what it is shown.
 *
 * Split into a fixed system prompt and a per-patient briefing for one practical
 * reason: the system half is byte-identical across every patient in the cohort,
 * so it carries a cache breakpoint and is billed at read rates after the first
 * request. The briefing is the only part that varies.
 *
 * The rules below are stated for the model, but none of them are *trusted* — every
 * one is re-checked in `validate.ts` against the assessment. The prompt exists to
 * make a valid response the easy one to produce, not to make an invalid one
 * impossible; that is the validator's job, and a rule that appeared only here
 * would be a rule enforced by good intentions.
 */
import type { AssistContext } from './context.js';

/**
 * The fixed instructions.
 *
 * Written to be short and prescriptive. The model is doing one narrow job —
 * turning a decided assessment into readable prose — and the most valuable
 * thing the prompt can do is make the boundaries of that job explicit, because
 * a model that starts reasoning about eligibility will produce sentences the
 * validator has to throw away.
 */
export const SYSTEM_PROMPT = `You write the explanatory text for a clinician-facing prior-authorization review tool.

A deterministic policy engine has ALREADY decided this case. The determination, each requirement's status, and the FHIR resources cited for each requirement are fixed and are not yours to produce, revisit, or dispute. You are given them so your prose describes the right thing. Your entire output is prose: a one-line clinical summary, one plain-language note per requirement, and the next steps a reviewer should chase.

RULES

0. The summary is ONE SENTENCE, under 200 characters, in this shape:

     "52-year-old female with long-standing morbid obesity and hypertension."

   Age, sex, and the clinical facts that matter to this policy. It orients a reviewer who is about to read the checklist — it does not restate the checklist, list the outstanding documentation, or explain the determination. Never write a second sentence.

1. Cite everything. The summary must list the ResourceType/id refs, taken verbatim from the briefing, that establish it. Never cite a ref that does not appear in the briefing. Never invent an id.

2. Absence and insufficiency are the same flag. Set "unknown": true when the summary mentions something not recorded, OR mentions evidence the briefing lists as related/insufficient. "unknown": false with an empty evidence list is not allowed, and neither is citing related evidence as though it settled the question.

3. Do not hedge. Never write "likely", "probably", "presumably", "possibly", "implied", "suggests", "appears to", "consistent with", "indicative of", "may have", or "may be". If the record does not establish something, say that it is not recorded and set "unknown": true.

4. Every number you write must come from a resource you cite in that same claim, or be one of the policy's own figures (the thresholds, the lookback window, the review dates) or the patient's age. Do not estimate, round, or infer a value.

5. Do not restate or contradict the outcome. Never write "is eligible", "not eligible", "ineligible", "meets all requirements", or "qualifies for surgery" — the determination is displayed separately. Never describe a requirement as met, satisfied, or documented unless the briefing gives its status as "met".

6. One note per requirement, all four, keyed by requirementId. A note explains why that requirement has the status the briefing gives it, in one or two sentences a reviewer can read.

7. Next steps are only for requirements whose status is "unknown". Each is a concrete action ("Request documentation of psychological evaluation"). Set requirementId to the requirement it would resolve, or null for a general step. If nothing is unresolved, return an empty list.

8. Keep it short: notes under 400 characters, steps under 200.

If you cannot follow a rule for some part of the summary, leave that part out. A shorter grounded answer is correct; a fuller one that guesses is not.`;

/**
 * The per-patient briefing.
 *
 * Serialized as JSON rather than prose so the refs, statuses and caveats reach
 * the model as data with unambiguous keys — a paragraph describing evidence
 * invites the model to paraphrase the ids, and a paraphrased id is a wrong id.
 */
export function buildBriefing(context: AssistContext): Record<string, unknown> {
  return {
    patient: {
      ref: context.demographics.ref,
      age: context.demographics.age,
      gender: context.demographics.gender,
      birthSex: context.demographics.birthSex,
      deceased: context.demographics.deceased,
    },
    policy: context.policy,
    determination: context.determination,
    determinationRationale: context.determinationRationale,
    requirements: context.requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      label: requirement.label,
      status: requirement.status,
      rationale: requirement.rationale,
      evidence: requirement.evidence.map((item) => ({
        ref: item.ref,
        display: item.display,
        date: item.date,
        value: item.value,
      })),
      relatedEvidenceInsufficient: requirement.relatedEvidence.map((item) => ({
        ref: item.ref,
        display: item.display,
        date: item.date,
        whyInsufficient: item.caveat,
      })),
      relatedEvidenceOmitted: requirement.relatedEvidenceOmitted,
    })),
    conflictingEvidence: context.conflicts,
    unresolvedRequirements: context.openGaps,
  };
}

export function buildUserPrompt(context: AssistContext): string {
  return [
    'Briefing for one patient. Every ref you may cite appears in it.',
    '',
    JSON.stringify(buildBriefing(context), null, 2),
    '',
    context.conflicts.length > 0
      ? 'Note the conflictingEvidence block: state the conflict, do not resolve it.'
      : 'There is no conflicting evidence on this patient.',
    'Return only the JSON object.',
  ].join('\n');
}
