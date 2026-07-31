/**
 * The model providers, behind one interface.
 *
 * `ModelClient` is the seam. Everything above it — the orchestrator, the
 * validator, the assembler — is a pure function of a draft, so every failure
 * mode the brief asks about (model failure, empty or partial responses,
 * conflicting evidence) is testable by handing the orchestrator a client that
 * fails in that specific way. Nothing in the test suite opens a socket.
 *
 * Two implementations ship:
 *
 *  - `StubClient` — the default. Composes the deterministic draft offline, so
 *    `pnpm dev` produces a complete, validated, model-shaped response with no
 *    API key and no network. It is not a mock of a model; it is a provider that
 *    happens to be a function, and it goes through the same validation and
 *    assembly as a real one.
 *  - `AnthropicClient` — the real path, opt-in via `ASSIST_PROVIDER=anthropic`.
 *
 * Errors are translated here rather than leaking SDK types upward, so the
 * orchestrator's degradation logic is written against three cases it can
 * exhaust instead of against a provider's exception hierarchy.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AssistContext } from './context.js';
import { NEXT_STEP, deterministicDraft } from './fallback.js';
import type { ModelDraft } from './schema.js';
import { DRAFT_SCHEMA, parseDraft } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

/** The model this tool calls when a live provider is configured. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** How long a single assist call may take before it is abandoned. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ModelClient {
  /** Provider id, recorded on the response so a reviewer can see which ran. */
  readonly provider: string;
  readonly model: string;
  draft(context: AssistContext): Promise<ModelDraft>;
}

/** The provider could not be reached, or refused. */
export class ModelCallError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'ModelCallError';
  }
}

/** The provider did not answer inside the deadline. */
export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}

/** The provider answered, but not with the required structure. */
export class ModelShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelShapeError';
  }
}

/**
 * The offline provider.
 *
 * Returns the same draft the degradation path would compose. That is the honest
 * thing for a stub to do — inventing richer prose would make the offline demo
 * look like it had a model behind it — and it means the happy path is exercised
 * end to end (schema shape, grounding checks, assembly, provenance) on a
 * machine with no credentials.
 */
export class StubClient implements ModelClient {
  readonly provider = 'stub';
  readonly model = 'deterministic-composer';

  draft(context: AssistContext): Promise<ModelDraft> {
    const composed = deterministicDraft(context);
    return Promise.resolve({
      ...composed,
      // The one thing the stub adds: a step per open gap, so the offline
      // response exercises the next-step validation rules rather than skipping
      // them with an empty list. The wording is the same action lexicon the
      // degraded path uses — a stub that invented better prose than the
      // fallback would make the offline demo misrepresent what it is.
      nextSteps: context.openGaps.map((gap) => ({
        text: NEXT_STEP[gap.reason],
        requirementId: (context.requirements.find(
          (entry) => entry.requirementId === gap.requirementId && entry.status === 'unknown',
        )?.requirementId ?? null) as ModelDraft['nextSteps'][number]['requirementId'],
      })),
    });
  }
}

/** Pulls the text out of a Messages response, ignoring thinking blocks. */
function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

export interface AnthropicClientOptions {
  /** Omitted when the SDK should resolve credentials from the environment. */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * The live provider.
 *
 * `output_config.format` constrains generation to `DRAFT_SCHEMA`, so a
 * structurally wrong answer is mostly prevented rather than detected. Mostly is
 * the operative word — `parseDraft` runs anyway, because schema-constrained
 * decoding is a property of this provider's API and not a guarantee this
 * codebase can make.
 *
 * No `temperature` or `top_p`: they are rejected on this model, and steering is
 * the prompt's job. Thinking is left at its default. The system block carries a
 * cache breakpoint because it is identical for every patient in the cohort.
 */
export class AnthropicClient implements ModelClient {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(options: AnthropicClientOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // `apiKey: undefined` is not the same as omitting it: the SDK falls back to
    // its own credential resolution only when the field is absent.
    this.client =
      options.apiKey === undefined
        ? new Anthropic({ maxRetries: 2 })
        : new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
  }

  async draft(context: AssistContext): Promise<ModelDraft> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 16_000,
          system: [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ],
          output_config: { format: { type: 'json_schema', schema: DRAFT_SCHEMA } },
          messages: [{ role: 'user', content: buildUserPrompt(context) }],
        },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new ModelTimeoutError(`${this.model} did not answer within ${this.timeoutMs}ms`);
      }
      if (error instanceof Anthropic.APIError) {
        throw new ModelCallError(`${this.model} returned ${error.status ?? 'an error'}: ${error.message}`, error);
      }
      throw new ModelCallError(error instanceof Error ? error.message : String(error), error);
    }

    // A refusal is a successful HTTP response with no usable content, so it has
    // to be checked before the content is read rather than caught as an error.
    if (message.stop_reason === 'refusal') {
      throw new ModelCallError(`${this.model} declined the request`);
    }

    const text = textOf(message);
    if (text === '') {
      throw new ModelShapeError(
        message.stop_reason === 'max_tokens'
          ? 'response hit the output limit before producing any text'
          : 'response contained no text',
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new ModelShapeError('response was not valid JSON');
    }

    const parsed = parseDraft(decoded);
    if (!parsed.ok) throw new ModelShapeError(parsed.message);
    return parsed.draft;
  }
}

/**
 * Chooses a provider from the environment.
 *
 * Defaults to the stub, and returns `undefined` only when a live provider was
 * asked for and cannot be built — a missing key is a degradation with a reason,
 * not a crash at startup, because the tool is fully usable without one.
 */
export function clientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { client: ModelClient } | { client: undefined; reason: string } {
  const requested = (env['ASSIST_PROVIDER'] ?? 'stub').trim().toLowerCase();

  if (requested === 'stub' || requested === '') return { client: new StubClient() };

  if (requested === 'anthropic') {
    const apiKey = env['ANTHROPIC_API_KEY']?.trim();
    const authToken = env['ANTHROPIC_AUTH_TOKEN']?.trim();
    // Checked here rather than left to surface as a 401, because "you forgot
    // the key" and "the provider rejected the request" are different problems
    // and only one of them is worth showing a clinician. A credential that
    // exists only as an `ant auth login` profile is not detected — export
    // ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for that case.
    if (!apiKey && !authToken) {
      return {
        client: undefined,
        reason: 'ASSIST_PROVIDER=anthropic but neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set',
      };
    }
    return {
      client: new AnthropicClient({
        ...(apiKey ? { apiKey } : {}),
        model: env['ASSIST_MODEL'] ?? DEFAULT_MODEL,
        timeoutMs: Number(env['ASSIST_TIMEOUT_MS'] ?? DEFAULT_TIMEOUT_MS),
      }),
    };
  }

  return { client: undefined, reason: `unknown ASSIST_PROVIDER "${requested}" (expected "stub" or "anthropic")` };
}
