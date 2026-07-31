/**
 * The grounding checks.
 *
 * A pure function of (draft, context) -> violations. No database, no clock, no
 * network: everything it needs was decided before the model was called, which
 * is what lets every rule here be tested by handing it a draft.
 *
 * ## What this is actually defending against
 *
 * The determinism boundary is already structural — the model has no field to
 * put a determination in (`schema.ts`). What is left is what the model *says*,
 * and the brief names the failures precisely: uncited medical claims, hedging
 * in place of evidence, and evidence that conflicts being written up as though
 * it did not. Each of those is a rule below.
 *
 * ## Every failure is total
 *
 * A draft that trips any check is discarded whole, and the response falls back
 * to Part C's own explanation. There is no partial acceptance — not because
 * salvaging the good half would be hard, but because a model that fabricated
 * one citation has told you what its other sentences are worth. The failure is
 * reported (`AssistViolation`) rather than silently swallowed, so a reviewer
 * sees that the model was consulted and rejected.
 *
 * ## The two heuristic rules, stated as heuristics
 *
 * `HEDGE_PATTERNS` and the number-traceability rule are not proofs. A model can
 * write an uncited claim in words the lexicon does not contain, and a claim
 * with no numbers in it cannot be caught by counting numbers. They bound the
 * failure rather than eliminating it, and they are deliberately strict: the
 * cost of a false reject is a deterministic answer, and the cost of a false
 * accept is a fabricated clinical statement in a prior-authorization review.
 */
import type { AssistViolation } from './dto.js';
import type { AssistContext } from './context.js';
import { numbersFor, numbersIn } from './context.js';
import type { ModelDraft } from './schema.js';
import { REQUIREMENT_IDS } from './schema.js';

/**
 * The summary is one line, and both of these enforce it.
 *
 * The length cap alone would not: a model can fit three clipped sentences into
 * 200 characters. `SENTENCE_BREAK` catches a terminator followed by more prose,
 * which is what "one line" actually means here.
 */
const MAX_SUMMARY_CHARS = 200;
const SENTENCE_BREAK = /[.!?]\s+\S/;

const MAX_STEPS = 6;
const MAX_NOTE_CHARS = 400;
const MAX_STEP_CHARS = 200;

/**
 * Language that asserts without evidence.
 *
 * The brief disallows "likely", "probably" and "implied"; the rest are the same
 * move in different words. Matched case-insensitively on word boundaries, so
 * "unlikely" and "multiplied" do not trip it.
 */
const HEDGE_PATTERNS: readonly { pattern: RegExp; word: string }[] = [
  { pattern: /\blikely\b/i, word: 'likely' },
  { pattern: /\bprobabl[ye]\b/i, word: 'probably' },
  { pattern: /\bpresumabl[ye]\b/i, word: 'presumably' },
  { pattern: /\bimpli(?:ed|es)\b/i, word: 'implied' },
  { pattern: /\bsuggest(?:s|ed|ive)\b/i, word: 'suggests' },
  { pattern: /\bappears? to\b/i, word: 'appears to' },
  { pattern: /\bconsistent with\b/i, word: 'consistent with' },
  { pattern: /\bindicative of\b/i, word: 'indicative of' },
  { pattern: /\bpossibl[ye]\b/i, word: 'possibly' },
  { pattern: /\bmay (?:have|be)\b/i, word: 'may have' },
  { pattern: /\bpresumed\b/i, word: 'presumed' },
];

/**
 * Phrases that assert an outcome, and the determination each one belongs to.
 *
 * Checked because the model still writes prose, and prose can say "this patient
 * is eligible" regardless of what the schema let it emit. Ordered longest-first
 * so `not eligible` is tested before `eligible` and does not report itself as a
 * contradiction.
 */
const OUTCOME_PHRASES: readonly { pattern: RegExp; asserts: string; label: string }[] = [
  { pattern: /\b(?:is |are )?not eligible\b/i, asserts: 'not-eligible', label: 'not eligible' },
  { pattern: /\bineligible\b/i, asserts: 'not-eligible', label: 'ineligible' },
  { pattern: /\bdoes not (?:meet|qualify|satisfy)\b/i, asserts: 'not-eligible', label: 'does not meet' },
  { pattern: /\b(?:is |are )eligible\b/i, asserts: 'eligible', label: 'eligible' },
  { pattern: /\bqualifies for (?:surgery|the procedure)\b/i, asserts: 'eligible', label: 'qualifies for surgery' },
  { pattern: /\bmeets all (?:the )?(?:requirements|criteria)\b/i, asserts: 'eligible', label: 'meets all requirements' },
];

/** Phrasings that claim a requirement was satisfied. */
const MET_PATTERN = /\b(?:is|are|was|were|has been|have been) (?:met|satisfied)\b|\bdocumented by\b|\bsatisfies\b/i;

/** Words that turn the sentence they lead into the opposite claim. */
const NEGATION = /\b(?:not|neither|nor|never|no|without|absent|lacks?)\b/i;

/**
 * Whether a note claims its requirement was satisfied.
 *
 * Sentence-scoped with a negation guard, because the naive version fires on
 * Part C's own wording — "BMI 28.4 is below 35, so neither arm of the policy is
 * satisfied" contains "is satisfied" and means the reverse. The deterministic
 * draft uses those rationales verbatim, so a check that could not read the
 * negation would reject the house's own prose.
 */
function assertsMet(text: string): boolean {
  for (const sentence of text.split(/(?<=[.;:])\s+/)) {
    const match = MET_PATTERN.exec(sentence);
    if (match === null) continue;
    if (NEGATION.test(sentence.slice(0, match.index))) continue;
    return true;
  }
  return false;
}

function violation(reason: AssistViolation['reason'], at: string, message: string): AssistViolation {
  return { reason, at, message };
}

/** Strips outcome phrases the determination itself licenses before matching. */
function outcomeViolations(text: string, at: string, determination: string): AssistViolation[] {
  const found: AssistViolation[] = [];
  let remaining = text;

  for (const phrase of OUTCOME_PHRASES) {
    const match = phrase.pattern.exec(remaining);
    if (match === null) continue;
    // Consume the match either way, so `eligible` inside `not eligible` is not
    // reported a second time as the opposite assertion.
    remaining = remaining.replace(phrase.pattern, ' ');
    if (phrase.asserts === determination) continue;
    found.push(
      violation(
        'contradicts-determination',
        at,
        `states "${phrase.label}" while the deterministic determination is "${determination}"`,
      ),
    );
  }
  return found;
}

/** Bounds and emptiness, shared by the three kinds of model text. */
function textViolations(text: string, at: string, limit: number): AssistViolation[] {
  const found: AssistViolation[] = [];
  if (text.trim() === '') {
    found.push(violation('incomplete-draft', at, 'is empty'));
  }
  if (text.length > limit) {
    found.push(violation('incomplete-draft', at, `is ${text.length} characters, over the ${limit} limit`));
  }
  for (const hedge of HEDGE_PATTERNS) {
    if (hedge.pattern.test(text)) {
      found.push(
        violation('hedged-claim', at, `uses "${hedge.word}", which asserts without evidence`),
      );
    }
  }
  return found;
}

/**
 * Checks one draft against one context.
 *
 * Returns every violation rather than the first, so a rejected draft can be
 * explained completely — one round of "fix this" per failure is not a debugging
 * loop anyone should have to run.
 */
export function validateDraft(draft: ModelDraft, context: AssistContext): AssistViolation[] {
  const violations: AssistViolation[] = [];

  // ---- summary -------------------------------------------------------------

  const claim = draft.summary;
  const at = 'summary';

  violations.push(...textViolations(claim.text, at, MAX_SUMMARY_CHARS));
  violations.push(...outcomeViolations(claim.text, at, context.determination));

  if (SENTENCE_BREAK.test(claim.text.trim())) {
    violations.push(violation('incomplete-draft', at, 'is more than one sentence'));
  }

  // Every factual claim must cite, or say outright that it cannot.
  if (claim.evidence.length === 0 && !claim.unknown) {
    violations.push(
      violation('ungrounded-citation', at, 'asserts a fact with no evidence and is not flagged unknown'),
    );
  }

  const grounded = new Set(context.ambientNumbers);
  for (const ref of claim.evidence) {
    const resource = context.citable.get(ref);
    if (resource === undefined) {
      violations.push(
        violation('ungrounded-citation', at, `cites ${ref}, which is not evidence in this assessment`),
      );
      continue;
    }
    // Part C already decided this resource does not satisfy its requirement.
    // A claim may surface it, but only as the gap it is.
    if (resource.tier === 'related' && !claim.unknown) {
      violations.push(
        violation(
          'conflict-resolved',
          at,
          `cites ${ref} as though it counted; the policy records it as insufficient (${resource.caveat ?? 'related evidence'})`,
        ),
      );
    }
    for (const number of numbersFor(resource)) grounded.add(number);
  }

  for (const number of numbersIn(claim.text)) {
    if (!grounded.has(number)) {
      violations.push(
        violation(
          'ungrounded-citation',
          at,
          `states the number ${number}, which appears in none of the resources it cites`,
        ),
      );
    }
  }

  // ---- requirement notes ---------------------------------------------------

  const seen = new Set<string>();
  for (const [index, note] of draft.requirementNotes.entries()) {
    const at = `requirementNotes[${index}]`;
    if (seen.has(note.requirementId)) {
      violations.push(violation('incomplete-draft', at, `repeats ${note.requirementId}`));
    }
    seen.add(note.requirementId);
    violations.push(...textViolations(note.note, at, MAX_NOTE_CHARS));
    violations.push(...outcomeViolations(note.note, at, context.determination));

    const requirement = context.requirements.find(
      (entry) => entry.requirementId === note.requirementId,
    );
    // A note that names a status other than the one Part C assigned is the
    // prose form of overriding the deterministic logic.
    if (requirement !== undefined) {
      if (assertsMet(note.note) && requirement.status !== 'met') {
        violations.push(
          violation(
            'contradicts-determination',
            at,
            `describes ${note.requirementId} as met, but its deterministic status is "${requirement.status}"`,
          ),
        );
      }
    }
  }

  for (const id of REQUIREMENT_IDS) {
    if (!seen.has(id)) {
      violations.push(violation('incomplete-draft', 'requirementNotes', `is missing ${id}`));
    }
  }

  // ---- next steps ----------------------------------------------------------

  if (draft.nextSteps.length > MAX_STEPS) {
    violations.push(
      violation('incomplete-draft', 'nextSteps', `has ${draft.nextSteps.length} steps, over the ${MAX_STEPS} limit`),
    );
  }

  for (const [index, step] of draft.nextSteps.entries()) {
    const at = `nextSteps[${index}]`;
    violations.push(...textViolations(step.text, at, MAX_STEP_CHARS));
    violations.push(...outcomeViolations(step.text, at, context.determination));

    if (step.requirementId === null) continue;
    const requirement = context.requirements.find(
      (entry) => entry.requirementId === step.requirementId,
    );
    if (requirement === undefined) {
      violations.push(violation('incomplete-draft', at, `targets unknown requirement ${step.requirementId}`));
      continue;
    }
    // Chasing a document for a requirement that is already resolved is not a
    // next step; it is the model inventing work the assessment does not need.
    if (requirement.status !== 'unknown') {
      violations.push(
        violation(
          'incomplete-draft',
          at,
          `targets ${step.requirementId}, which is already "${requirement.status}" and needs nothing`,
        ),
      );
    }
  }

  return violations;
}
