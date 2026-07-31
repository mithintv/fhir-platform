/**
 * AI Assist (Part D) — the orchestrator and the public surface.
 *
 * The whole section is four steps, and the shape of the function is the design:
 *
 *     assess (Part C)  →  brief  →  draft (model)  →  validate  →  assemble
 *                                        │                │
 *                                        └── any failure ─┴──→ deterministic result
 *
 * Every arrow out of the model leads to a complete `AssistResult`. There is no
 * path through this file that returns an error to the caller because the model
 * misbehaved: a provider that is missing, unreachable, slow, malformed,
 * ungrounded, hedging, or contradicting the determination all end in the same
 * place — Part C's own explanation, labelled with which of those happened. That
 * is the "degrade safely" requirement, and making it the only exit is cheaper
 * than remembering to handle it at each call site.
 *
 * ## Caching
 *
 * Successful model responses are cached per connection, keyed by patient,
 * review date and provider. Degraded responses are deliberately *not* cached:
 * a transient timeout should not pin a patient to the deterministic explanation
 * for the life of the process, and re-asking is exactly what a reviewer who
 * pressed the button again would expect.
 */
import type { Db } from '../store/db.js';
import type { EligibilityAssessment } from '../eligibility/dto.js';
import { assessPatient } from '../eligibility/index.js';
// Not `getClinicalSnapshot`: the briefing needs demographics and an age, and
// the snapshot additionally reads conditions, procedures, the key-observation
// panel and the resource mix — around 350 ms of work per call that nothing here
// looks at. Same three functions the snapshot itself uses for this part, so the
// age in an assist summary is still the age on the patient header.
import { computeAge, getPatientRecord, toDemographics } from '../query/patients.js';
import type { AssistResult, DegradeReason } from './dto.js';
import type { AssistContext } from './context.js';
import { buildAssistContext } from './context.js';
import { assemble, deterministicResult } from './fallback.js';
import { validateDraft } from './validate.js';
import type { ModelClient } from './client.js';
import { ModelShapeError, ModelTimeoutError, clientFromEnv } from './client.js';

export type { AssistChecklistItem, AssistProvenance, AssistResult, AssistViolation, DegradeReason } from './dto.js';
export type { AssistContext, CitableResource } from './context.js';
export { buildAssistContext } from './context.js';
export type { ModelClient } from './client.js';
export type { ModelClaim, ModelDraft, ModelNote, ModelStep } from './schema.js';
export { AnthropicClient, ModelCallError, ModelShapeError, ModelTimeoutError, StubClient, clientFromEnv } from './client.js';
export { deterministicDraft, deterministicResult } from './fallback.js';
export { validateDraft } from './validate.js';
export { DRAFT_SCHEMA, parseDraft, REQUIREMENT_IDS } from './schema.js';
export { SYSTEM_PROMPT, buildBriefing, buildUserPrompt } from './prompt.js';

export interface AssistOptions {
  /** Review date, `YYYY-MM-DD`. Defaults as Part C does, to the data horizon. */
  requested?: string;
  /** Overrides the environment-selected provider. Tests always pass this. */
  client?: ModelClient;
  /** Injected for deterministic ages under test. */
  now?: Date;
  /** Skips the cache, for tests that run several clients over one store. */
  cache?: boolean;
}

const CACHES = new WeakMap<Db, Map<string, AssistResult>>();

function cacheFor(db: Db): Map<string, AssistResult> {
  const existing = CACHES.get(db);
  if (existing !== undefined) return existing;
  const created = new Map<string, AssistResult>();
  CACHES.set(db, created);
  return created;
}

/** Classifies a thrown provider error into the reason a reviewer will see. */
function reasonFor(error: unknown): { reason: DegradeReason; detail: string } {
  if (error instanceof ModelTimeoutError) return { reason: 'timeout', detail: error.message };
  if (error instanceof ModelShapeError) return { reason: 'unparseable', detail: error.message };
  return {
    reason: 'model-error',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/** Appends the technical cause to the reviewer-facing sentence. */
function withCause(base: string, cause: string): string {
  return cause.trim() === '' ? base : `${base} (${cause})`;
}

/**
 * Produces the assist response for one patient.
 *
 * `undefined` means the patient is not in the store — the only failure this
 * function reports as an absence rather than as a degraded answer, because
 * there is nothing to explain.
 */
export async function assistPatient(
  db: Db,
  patientId: string,
  options: AssistOptions = {},
): Promise<AssistResult | undefined> {
  const selected: Selection =
    options.client === undefined ? resolveClient() : { client: options.client };

  // The lookup happens before the assessment rather than after it, so a repeat
  // costs nothing at all instead of costing the evidence gather again. Keying
  // on the *requested* review date rather than the resolved one is safe because
  // the store is opened read-only and cannot move under a running process, so
  // the same key could not resolve to a different date later.
  const useCache = options.cache !== false && selected.client !== undefined;
  const cache = cacheFor(db);
  const key = [
    patientId,
    options.requested ?? 'default',
    selected.client?.provider,
    selected.client?.model,
  ].join(' | ');
  if (useCache) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }

  const assessment = assessPatient(db, patientId, { requested: options.requested });
  if (assessment === undefined) return undefined;

  const patient = getPatientRecord(db, patientId);
  if (patient === undefined) return undefined;

  const context = buildAssistContext(
    assessment,
    toDemographics(patient),
    computeAge(patient, options.now),
  );

  if (selected.client === undefined) {
    return degraded(assessment, context, 'no-provider', selected.reason);
  }

  const result = await run(assessment, context, selected.client);
  // Only model-authored answers are worth keeping: a degraded one should be
  // retried, not remembered.
  if (useCache && result.provenance.kind === 'model') cache.set(key, result);
  return result;
}

type Selection = { client: ModelClient; reason?: undefined } | { client: undefined; reason: string };

function resolveClient(): Selection {
  const selected = clientFromEnv();
  return selected.client === undefined
    ? { client: undefined, reason: selected.reason }
    : { client: selected.client };
}

function degraded(
  assessment: EligibilityAssessment,
  context: AssistContext,
  reason: DegradeReason,
  cause?: string,
): AssistResult {
  const base = deterministicResult(assessment, context, reason);
  if (cause === undefined || base.provenance.kind !== 'deterministic') return base;
  return {
    ...base,
    provenance: { ...base.provenance, detail: withCause(base.provenance.detail, cause) },
  };
}

async function run(
  assessment: EligibilityAssessment,
  context: AssistContext,
  client: ModelClient,
): Promise<AssistResult> {
  let draft;
  try {
    draft = await client.draft(context);
  } catch (error) {
    const classified = reasonFor(error);
    return degraded(assessment, context, classified.reason, classified.detail);
  }

  const violations = validateDraft(draft, context);
  if (violations.length > 0) {
    // The first violation names the class of failure; all of them are carried,
    // because a response rejected for one reason is usually wrong in several.
    const leading = violations[0] as (typeof violations)[number];
    const base = deterministicResult(assessment, context, leading.reason, violations);
    if (base.provenance.kind !== 'deterministic') return base;
    return {
      ...base,
      provenance: {
        ...base.provenance,
        detail: withCause(base.provenance.detail, `${leading.at} ${leading.message}`),
      },
    };
  }

  return assemble(assessment, context, draft, {
    kind: 'model',
    provider: client.provider,
    model: client.model,
    policyVersion: assessment.policy.version,
    asOf: assessment.policy.asOf,
  });
}
