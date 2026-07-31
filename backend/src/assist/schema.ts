/**
 * The only shape a model is allowed to return, in both languages that need it.
 *
 * `ModelDraft` is what the rest of the backend types against; `DRAFT_SCHEMA` is
 * the same contract as JSON Schema, handed to the Messages API as
 * `output_config.format` so the provider constrains generation rather than the
 * server discovering a malformed answer afterwards.
 *
 * Note what is *not* here: no determination, no requirement status, no evidence
 * list per requirement. Those come from Part C (`dto.ts` explains why), and
 * leaving them out of the schema is what makes the determinism boundary
 * structural — a model that wanted to change an outcome has no field to put it
 * in, and one that mentions a different outcome in prose fails the grounding
 * check instead.
 *
 * `parseDraft` re-checks the shape anyway. Schema-constrained decoding is a
 * property of one provider's API, not of the type system, and the stub provider
 * and the tests both produce drafts without going near it.
 */
import type { RequirementId } from '../eligibility/dto.js';

/** The four requirement ids, in the order Part C reports them. */
export const REQUIREMENT_IDS: readonly RequirementId[] = [
  'bmi-threshold',
  'comorbidity',
  'weight-loss-attempts',
  'psychological-evaluation',
];

export interface ModelClaim {
  text: string;
  /** `ResourceType/id` refs. Empty only when `unknown` is true. */
  evidence: string[];
  unknown: boolean;
}

export interface ModelNote {
  requirementId: RequirementId;
  note: string;
}

export interface ModelStep {
  text: string;
  /** The requirement this step would resolve, or null for a general step. */
  requirementId: RequirementId | null;
}

export interface ModelDraft {
  /**
   * One sentence, with the resources backing it.
   *
   * Singular on purpose. The brief's example — "52-year-old female with
   * long-standing morbid obesity and hypertension." — is a one-line orientation
   * for a reviewer about to read the checklist, not a report. A model given an
   * array writes an array; a model given one field writes one sentence.
   */
  summary: ModelClaim;
  requirementNotes: ModelNote[];
  nextSteps: ModelStep[];
}

/**
 * The JSON Schema for `output_config.format`.
 *
 * Deliberately carries no `minItems`/`maxItems`/`minLength` bounds: structured
 * outputs do not support numeric or array-length constraints, and a schema that
 * silently drops them would read as though the bounds were enforced. They are
 * enforced in `validate.ts`, where a violation is reportable rather than
 * invisible.
 */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'requirementNotes', 'nextSteps'],
  properties: {
    summary: {
      type: 'object',
      description:
        'The clinical summary: a single sentence orienting a reviewer, in the shape of ' +
        '"52-year-old female with long-standing morbid obesity and hypertension."',
      additionalProperties: false,
      required: ['text', 'evidence', 'unknown'],
      properties: {
        text: {
          type: 'string',
          description:
            'Exactly one sentence, under 200 characters. Demographics plus the clinical ' +
            'facts that matter to this policy. No hedging, no uncited assertion.',
        },
        evidence: {
          type: 'array',
          description: 'ResourceType/id refs taken from the briefing. Empty only when unknown is true.',
          items: { type: 'string' },
        },
        unknown: {
          type: 'boolean',
          description:
            'True when the sentence mentions a gap: something not recorded, or evidence the ' +
            'policy marked insufficient.',
        },
      },
    },
    requirementNotes: {
      type: 'array',
      description: 'Exactly one entry per requirement, explaining its already-decided status.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requirementId', 'note'],
        properties: {
          requirementId: { type: 'string', enum: [...REQUIREMENT_IDS] },
          note: {
            type: 'string',
            description:
              'Plain-language restatement of why this requirement has the status it has. ' +
              'Does not assert a different status.',
          },
        },
      },
    },
    nextSteps: {
      type: 'array',
      description: 'What a reviewer should chase, one entry each. Empty when nothing is outstanding.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'requirementId'],
        properties: {
          text: { type: 'string' },
          requirementId: {
            description: 'The unresolved requirement this step would close, or null.',
            anyOf: [{ type: 'string', enum: [...REQUIREMENT_IDS] }, { type: 'null' }],
          },
        },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ParseResult =
  | { ok: true; draft: ModelDraft }
  | { ok: false; message: string };

/**
 * Structural check on a decoded draft.
 *
 * Reports the first problem with the path to it, because "the model returned
 * something wrong" is not a useful thing to show a reviewer and not a useful
 * thing to debug against.
 */
export function parseDraft(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, message: 'response was not a JSON object' };

  const ids = new Set<string>(REQUIREMENT_IDS);
  const requirementNotes: ModelNote[] = [];
  const nextSteps: ModelStep[] = [];

  const rawSummary = value['summary'];
  if (!isRecord(rawSummary)) return { ok: false, message: 'summary was not an object' };
  if (typeof rawSummary['text'] !== 'string') {
    return { ok: false, message: 'summary.text was not a string' };
  }
  if (typeof rawSummary['unknown'] !== 'boolean') {
    return { ok: false, message: 'summary.unknown was not a boolean' };
  }
  if (
    !Array.isArray(rawSummary['evidence']) ||
    (rawSummary['evidence'] as unknown[]).some((ref) => typeof ref !== 'string')
  ) {
    return { ok: false, message: 'summary.evidence was not an array of strings' };
  }
  const summary: ModelClaim = {
    text: rawSummary['text'],
    evidence: rawSummary['evidence'] as string[],
    unknown: rawSummary['unknown'],
  };

  if (!Array.isArray(value['requirementNotes'])) {
    return { ok: false, message: 'requirementNotes was not an array' };
  }
  for (const [index, entry] of (value['requirementNotes'] as unknown[]).entries()) {
    if (!isRecord(entry)) {
      return { ok: false, message: `requirementNotes[${index}] was not an object` };
    }
    const id = entry['requirementId'];
    if (typeof id !== 'string' || !ids.has(id)) {
      return { ok: false, message: `requirementNotes[${index}].requirementId is not a requirement` };
    }
    if (typeof entry['note'] !== 'string') {
      return { ok: false, message: `requirementNotes[${index}].note was not a string` };
    }
    requirementNotes.push({ requirementId: id as RequirementId, note: entry['note'] });
  }

  if (!Array.isArray(value['nextSteps'])) {
    return { ok: false, message: 'nextSteps was not an array' };
  }
  for (const [index, entry] of (value['nextSteps'] as unknown[]).entries()) {
    if (!isRecord(entry)) return { ok: false, message: `nextSteps[${index}] was not an object` };
    if (typeof entry['text'] !== 'string') {
      return { ok: false, message: `nextSteps[${index}].text was not a string` };
    }
    const id = entry['requirementId'];
    if (id !== null && id !== undefined && (typeof id !== 'string' || !ids.has(id))) {
      return { ok: false, message: `nextSteps[${index}].requirementId is not a requirement` };
    }
    nextSteps.push({
      text: entry['text'],
      requirementId: (id ?? null) as RequirementId | null,
    });
  }

  return { ok: true, draft: { summary, requirementNotes, nextSteps } };
}
