/**
 * Tests for Part D.
 *
 * Two things are being tested and they need different setups.
 *
 * The **grounding checks** are tested by handing `validateDraft` a draft that
 * breaks exactly one rule. There is one such test per rule, because a rule with
 * no test is a rule that might already be unreachable.
 *
 * The **degradation paths** are tested by handing `assistPatient` a
 * `ModelClient` that fails in a specific way. That interface is the whole
 * reason the failure handling is testable at all: "the provider timed out" is a
 * one-line stub rather than a network fixture, and nothing here opens a socket.
 *
 * Everything runs against a store built by the real ingest pipeline
 * (`buildFixtureStore`) and assessed by the real Part C evaluator, so the refs
 * a draft is checked against are refs the normalizer actually wrote.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildFixtureStore, codedResource, observation, patient } from '../query/fixture.js';
import { assessPatient } from '../eligibility/index.js';
import { SNOMED } from '../eligibility/policy.js';
import { getClinicalSnapshot } from '../query/snapshot.js';
import type { EligibilityAssessment } from '../eligibility/dto.js';
import type { AssistContext } from './context.js';
import { buildAssistContext } from './context.js';
import { deterministicDraft } from './fallback.js';
import { validateDraft } from './validate.js';
import { parseDraft } from './schema.js';
import type { ModelDraft } from './schema.js';
import type { AssistResult } from './dto.js';
import type { ModelClient } from './client.js';
import { ModelCallError, ModelShapeError, ModelTimeoutError, StubClient } from './client.js';
import { assistPatient } from './index.js';

/** Pinned so the lookback window cannot drift with the fixture's contents. */
const AS_OF = '2023-01-01';
const BMI = '39156-5';
const NOW = new Date('2023-01-01T00:00:00Z');

const recentBmi = (value: number) =>
  observation('bmi1', BMI, '2022-06-01T10:00:00Z', { value, unit: 'kg/m2' });

const hypertension = codedResource(
  'Condition',
  'c1',
  { system: SNOMED, code: '59621000', display: 'Essential hypertension (disorder)' },
  '2015-01-01',
  { clinicalStatus: { coding: [{ code: 'active' }] } },
);

/** A depression screen: real, clinically adjacent, and explicitly insufficient. */
const depressionScreen = codedResource(
  'Procedure',
  'ds1',
  { system: SNOMED, code: '171207006', display: 'Depression screening (procedure)' },
  '2022-04-04T10:00:00Z',
);

const psychEval = codedResource(
  'Procedure',
  'ps1',
  {
    system: SNOMED,
    code: '79094001',
    display: 'Initial psychiatric interview with mental status and evaluation (procedure)',
  },
  '2022-03-03T10:00:00Z',
);

const exerciseClass = codedResource(
  'Procedure',
  'wl1',
  { system: SNOMED, code: '229095001', display: 'Exercise class (regime/therapy)' },
  '2022-02-02T10:00:00Z',
);

interface Fixture {
  db: ReturnType<typeof buildFixtureStore>;
  assessment: EligibilityAssessment;
  context: AssistContext;
}

function fixture(resources: unknown[] = [recentBmi(41.7)]): Fixture {
  const db = buildFixtureStore([patient(), ...resources]);
  const assessment = assessPatient(db, 'p1', { requested: AS_OF });
  if (!assessment) throw new Error('fixture patient p1 was not assessed');
  const snapshot = getClinicalSnapshot(db, 'p1', NOW);
  if (!snapshot) throw new Error('fixture patient p1 has no snapshot');
  return { db, assessment, context: buildAssistContext(assessment, snapshot.patient, snapshot.age) };
}

/** A client that returns whatever draft the test hands it. */
const clientOf = (draft: ModelDraft): ModelClient => ({
  provider: 'test',
  model: 'test-model',
  draft: () => Promise.resolve(draft),
});

/** A client that fails the way the test wants it to. */
const failingClient = (error: unknown): ModelClient => ({
  provider: 'test',
  model: 'test-model',
  draft: () => Promise.reject(error),
});

/** The deterministic draft, which every rule below is a mutation of. */
function baseDraft(context: AssistContext): ModelDraft {
  return deterministicDraft(context);
}

const reasons = (context: AssistContext, draft: ModelDraft): string[] =>
  validateDraft(draft, context).map((entry) => entry.reason);

async function assist(
  resources: unknown[],
  client: ModelClient,
): Promise<AssistResult> {
  const { db } = fixture(resources);
  const result = await assistPatient(db, 'p1', {
    requested: AS_OF,
    client,
    now: NOW,
    cache: false,
  });
  if (!result) throw new Error('assist returned no result for the fixture patient');
  return result;
}

describe('the deterministic floor', () => {
  it("passes its own grounding checks, so the rules describe a reachable standard", () => {
    for (const resources of [
      [recentBmi(41.7)],
      [recentBmi(36.2), hypertension],
      [recentBmi(28.4)],
      [],
      [recentBmi(41.7), depressionScreen, exerciseClass, psychEval],
    ]) {
      const { context } = fixture(resources);
      expect(validateDraft(deterministicDraft(context), context)).toEqual([]);
    }
  });

  it('writes the summary as a single sentence, in the shape the brief asks for', async () => {
    const result = await assist([recentBmi(41.7), hypertension], new StubClient());

    // "52-year-old female with long-standing morbid obesity and hypertension."
    expect(result.clinicalSummary).toMatch(/^\d+-year-old \w+ with .+\.$/);
    expect(result.clinicalSummary.length).toBeLessThanOrEqual(200);
    // One terminator, at the end — no second sentence hiding inside the line.
    expect(result.clinicalSummary).not.toMatch(/[.!?]\s+\S/);
    expect(result.clinicalSummaryEvidence.length).toBeGreaterThan(0);
  });

  it('rejects a summary that runs to more than one sentence', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    draft.summary = {
      text: 'Patient is 41 years old. A BMI is on file. Documentation is outstanding.',
      evidence: [context.demographics.ref],
      unknown: true,
    };

    expect(reasons(context, draft)).toContain('incomplete-draft');
  });

  it('produces a complete result even when no model is involved', async () => {
    const result = await assist([recentBmi(41.7)], failingClient(new ModelCallError('down')));

    expect(result.provenance.kind).toBe('deterministic');
    expect(result.clinicalSummary.length).toBeGreaterThan(0);
    expect(result.checklist).toHaveLength(4);
    expect(result.recommendedNextSteps.length).toBeGreaterThan(0);
    // The brief's own example next step, produced without a model.
    expect(result.recommendedNextSteps).toContain(
      'Request documentation of psychological evaluation.',
    );
  });
});

describe('the determinism boundary', () => {
  it('takes the determination and every status from Part C, not from the draft', async () => {
    const { assessment } = fixture([recentBmi(36.2)]);
    const result = await assist([recentBmi(36.2)], new StubClient());

    expect(result.eligibilityAssessment).toBe(assessment.determination);
    expect(result.checklist.map((item) => item.status)).toEqual(
      assessment.requirements.map((finding) => finding.status),
    );
    expect(result.checklist.map((item) => item.evidence)).toEqual(
      assessment.requirements.map((finding) => finding.evidence.map((item) => item.ref)),
    );
  });

  it('rejects prose that asserts an outcome the policy did not reach', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    draft.summary = { text: 'This patient is eligible for surgery.', evidence: [context.demographics.ref], unknown: false };

    expect(reasons(context, draft)).toContain('contradicts-determination');
  });

  it('rejects a note that describes an unresolved requirement as met', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    const note = draft.requirementNotes.find((entry) => entry.requirementId === 'psychological-evaluation');
    if (!note) throw new Error('draft is missing the psychological-evaluation note');
    note.note = 'The psychological evaluation requirement is met.';

    expect(reasons(context, draft)).toContain('contradicts-determination');
  });
});

describe('grounding', () => {
  it('rejects a citation to a resource outside the assessment', () => {
    const { context } = fixture();
    const draft = baseDraft(context);
    draft.summary = { text: 'Patient has a recorded diagnosis.', evidence: ['Condition/not-real'], unknown: false };

    expect(reasons(context, draft)).toContain('ungrounded-citation');
  });

  it('rejects a factual claim with no evidence at all', () => {
    const { context } = fixture();
    const draft = baseDraft(context);
    draft.summary = { text: 'Patient has long-standing morbid obesity.', evidence: [], unknown: false };

    expect(reasons(context, draft)).toContain('ungrounded-citation');
  });

  it('allows an uncited claim when it is flagged as a gap', () => {
    const { context } = fixture();
    const draft = baseDraft(context);
    draft.summary = { text: 'No psychological evaluation is recorded.', evidence: [], unknown: true };

    expect(validateDraft(draft, context)).toEqual([]);
  });

  it('rejects a number that appears in none of the resources the claim cites', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    const bmiRef = context.requirements.find((entry) => entry.requirementId === 'bmi-threshold')
      ?.evidence[0]?.ref;
    draft.summary = { text: 'Most recent BMI is 38.2 kg/m2.', evidence: [bmiRef as string], unknown: false };

    expect(reasons(context, draft)).toContain('ungrounded-citation');
  });

  it('accepts the number the cited resource actually carries', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    const bmiRef = context.requirements.find((entry) => entry.requirementId === 'bmi-threshold')
      ?.evidence[0]?.ref;
    draft.summary = { text: 'Most recent BMI is 41.7 kg/m2.', evidence: [bmiRef as string], unknown: false };

    expect(validateDraft(draft, context)).toEqual([]);
  });

  it.each([
    'Patient likely has an undiagnosed comorbidity.',
    'Weight-loss attempts are probably documented elsewhere.',
    'The record suggests a psychological evaluation took place.',
    'This is consistent with a supervised weight-loss programme.',
    'The patient may have attempted weight loss.',
  ])('rejects hedged prose: %s', (text) => {
    const { context } = fixture();
    const draft = baseDraft(context);
    draft.summary = { text, evidence: [context.demographics.ref], unknown: false };

    expect(reasons(context, draft)).toContain('hedged-claim');
  });
});

describe('conflicting evidence', () => {
  it('surfaces insufficient evidence as a conflict the model is briefed on', () => {
    const { context } = fixture([recentBmi(41.7), depressionScreen]);

    expect(context.conflicts.map((entry) => entry.ref)).toContain('Procedure/ds1');
    expect(context.citable.get('Procedure/ds1')?.tier).toBe('related');
  });

  it('rejects a claim that writes insufficient evidence up as though it counted', () => {
    const { context } = fixture([recentBmi(41.7), depressionScreen]);
    const draft = baseDraft(context);
    draft.summary = {
      text: 'A psychological evaluation was performed.',
      evidence: ['Procedure/ds1'],
      unknown: false,
    };

    expect(reasons(context, draft)).toContain('conflict-resolved');
  });

  it('allows the same evidence to be cited as the near-miss it is', () => {
    const { context } = fixture([recentBmi(41.7), depressionScreen]);
    const draft = baseDraft(context);
    draft.summary = {
      text: 'A depression screening is on file; it is not a psychological evaluation.',
      evidence: ['Procedure/ds1'],
      unknown: true,
    };

    expect(validateDraft(draft, context)).toEqual([]);
  });
});

describe('completeness', () => {
  it('rejects a draft missing a requirement note', () => {
    const { context } = fixture();
    const draft = baseDraft(context);
    draft.requirementNotes = draft.requirementNotes.filter(
      (entry) => entry.requirementId !== 'comorbidity',
    );

    expect(reasons(context, draft)).toContain('incomplete-draft');
  });

  it('rejects a draft with no summary at all', () => {
    const { context } = fixture();
    const draft = { ...baseDraft(context), summary: { text: '', evidence: [], unknown: true } };

    expect(reasons(context, draft)).toContain('incomplete-draft');
  });

  it('rejects a next step aimed at a requirement that needs nothing', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    draft.nextSteps = [{ text: 'Obtain a BMI measurement.', requirementId: 'bmi-threshold' }];

    expect(reasons(context, draft)).toContain('incomplete-draft');
  });

  it('accepts a next step aimed at an open gap', () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    draft.nextSteps = [
      { text: 'Request documentation of psychological evaluation.', requirementId: 'psychological-evaluation' },
    ];

    expect(validateDraft(draft, context)).toEqual([]);
  });
});

describe('parseDraft', () => {
  it.each([
    ['a bare string', '"nope"'],
    ['a missing summary', '{"requirementNotes":[],"nextSteps":[]}'],
    // The summary is one claim, not a list of them — a model that returned the
    // old array shape has to be rejected rather than silently read as `[0]`.
    ['a summary that is an array', '{"summary":[{"text":"x","evidence":[],"unknown":true}],"requirementNotes":[],"nextSteps":[]}'],
    ['a summary with no unknown flag', '{"summary":{"text":"x","evidence":[]},"requirementNotes":[],"nextSteps":[]}'],
    ['a note keyed by something that is not a requirement', '{"summary":{"text":"x","evidence":[],"unknown":true},"requirementNotes":[{"requirementId":"invented","note":"x"}],"nextSteps":[]}'],
    ['evidence that is not strings', '{"summary":{"text":"x","evidence":[1],"unknown":false},"requirementNotes":[],"nextSteps":[]}'],
  ])('rejects %s', (_label, json) => {
    const parsed = parseDraft(JSON.parse(json));
    expect(parsed.ok).toBe(false);
  });

  it('accepts a well-formed draft and normalizes an absent requirementId to null', () => {
    const parsed = parseDraft({
      summary: { text: 'x', evidence: [], unknown: true },
      requirementNotes: [{ requirementId: 'comorbidity', note: 'y' }],
      nextSteps: [{ text: 'z' }],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.nextSteps[0]?.requirementId).toBeNull();
  });
});

describe('failure handling', () => {
  it.each([
    ['a transport failure', new ModelCallError('connection refused'), 'model-error'],
    ['a timeout', new ModelTimeoutError('no answer in 60000ms'), 'timeout'],
    ['an unparseable response', new ModelShapeError('response was not valid JSON'), 'unparseable'],
    ['an unexpected throw', new Error('boom'), 'model-error'],
  ])('degrades on %s', async (_label, error, expected) => {
    const result = await assist([recentBmi(41.7)], failingClient(error));

    expect(result.provenance.kind).toBe('deterministic');
    if (result.provenance.kind !== 'deterministic') return;
    expect(result.provenance.reason).toBe(expected);
    // The reviewer-facing sentence carries the technical cause, so a degraded
    // response is diagnosable without reading the server log.
    expect(result.provenance.detail).toContain(
      error instanceof Error ? error.message : String(error),
    );
  });

  it('degrades when no provider is configured, rather than failing the request', async () => {
    vi.stubEnv('ASSIST_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const { db } = fixture([recentBmi(41.7)]);
      const result = await assistPatient(db, 'p1', { requested: AS_OF, now: NOW, cache: false });

      expect(result?.provenance.kind).toBe('deterministic');
      if (result?.provenance.kind !== 'deterministic') return;
      expect(result.provenance.reason).toBe('no-provider');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('carries every violation, not just the one that decided the outcome', async () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    draft.summary = { text: 'Patient likely qualifies.', evidence: ['Observation/ghost'], unknown: false };

    const result = await assist([recentBmi(41.7)], clientOf(draft));

    expect(result.provenance.kind).toBe('deterministic');
    if (result.provenance.kind !== 'deterministic') return;
    expect(result.provenance.violations.length).toBeGreaterThan(1);
    expect(result.provenance.violations.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(['hedged-claim', 'ungrounded-citation']),
    );
  });

  it('still returns a complete, usable result when the draft is rejected', async () => {
    const { context } = fixture([recentBmi(41.7)]);
    const draft = baseDraft(context);
    draft.summary = { text: 'Fabricated.', evidence: ['Observation/ghost'], unknown: false };

    const result = await assist([recentBmi(41.7)], clientOf(draft));

    expect(result.checklist).toHaveLength(4);
    expect(result.clinicalSummary).not.toContain('Fabricated');
    expect(result.clinicalSummaryEvidence.every((ref) => context.citable.has(ref))).toBe(true);
  });
});

describe('the offline provider', () => {
  it('produces a model-provenance result with no key and no network', async () => {
    const result = await assist([recentBmi(36.2), hypertension], new StubClient());

    expect(result.provenance.kind).toBe('model');
    if (result.provenance.kind !== 'model') return;
    expect(result.provenance.provider).toBe('stub');
    expect(result.provenance.asOf).toBe(AS_OF);
  });

  it('cites only resources the assessment already cited', async () => {
    const { context } = fixture([recentBmi(36.2), hypertension, depressionScreen]);
    const result = await assist([recentBmi(36.2), hypertension, depressionScreen], new StubClient());

    for (const ref of result.clinicalSummaryEvidence) {
      expect(context.citable.has(ref)).toBe(true);
    }
  });
});

describe('caching', () => {
  it('serves a repeated model response from cache and never caches a degraded one', async () => {
    const { db, context } = fixture([recentBmi(41.7)]);
    let calls = 0;
    const counting: ModelClient = {
      provider: 'test',
      model: 'test-model',
      draft: () => {
        calls += 1;
        return Promise.resolve(baseDraft(context));
      },
    };

    await assistPatient(db, 'p1', { requested: AS_OF, client: counting, now: NOW });
    await assistPatient(db, 'p1', { requested: AS_OF, client: counting, now: NOW });
    expect(calls).toBe(1);

    const failing = failingClient(new ModelCallError('down'));
    const { db: other } = fixture([recentBmi(41.7)]);
    await assistPatient(other, 'p1', { requested: AS_OF, client: failing, now: NOW });
    const second = await assistPatient(other, 'p1', { requested: AS_OF, client: failing, now: NOW });
    expect(second?.provenance.kind).toBe('deterministic');
  });
});

describe('unknown patients', () => {
  it('returns nothing rather than an explanation of nothing', async () => {
    const { db } = fixture();
    expect(await assistPatient(db, 'nobody', { requested: AS_OF, client: new StubClient() })).toBeUndefined();
  });
});
