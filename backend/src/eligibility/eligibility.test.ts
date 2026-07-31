/**
 * Tests for the Part C eligibility logic.
 *
 * These run through the real ingest pipeline (`buildFixtureStore` normalizes
 * raw FHIR and writes it with the production writer and schema) and then through
 * the real gather + evaluate path. A test that hand-built a `PatientEvidence`
 * would prove the evaluator folds statuses correctly while saying nothing about
 * whether the code sets actually match what the normalizer writes — and every
 * interesting failure in this layer lives at that seam.
 *
 * `asOf` is pinned on every assessment. Left to default it would follow the
 * fixture's own newest date, so adding an unrelated resource to a test could
 * silently move another assertion's lookback window.
 */
import { describe, expect, it } from 'vitest';
import { buildFixtureStore, codedResource, condition, observation, patient } from '../query/fixture.js';
import { assessCohort, assessPatient } from './cohort.js';
import { BARIATRIC_POLICY, LOINC, RXNORM, SNOMED } from './policy.js';
import type { EligibilityAssessment, RequirementFinding, RequirementId } from './dto.js';

/** The review date every test scores against. */
const AS_OF = '2023-01-01';

/** LOINC 39156-5 is the BMI ratio; 59576-9 is the paediatric percentile. */
const BMI = '39156-5';

function assess(resources: unknown[], asOf = AS_OF): EligibilityAssessment {
  const db = buildFixtureStore([patient(), ...resources]);
  const assessment = assessPatient(db, 'p1', { requested: asOf });
  if (!assessment) throw new Error('fixture patient p1 was not assessed');
  return assessment;
}

/** Pulls one requirement, failing loudly if the checklist dropped it. */
function requirement(assessment: EligibilityAssessment, id: RequirementId): RequirementFinding {
  const found = assessment.requirements.find((entry) => entry.id === id);
  if (!found) throw new Error(`checklist is missing the ${id} requirement entirely`);
  return found;
}

const gaps = (assessment: EligibilityAssessment): string[] =>
  assessment.unknownReasons.map((entry) => entry.reason);

/** A BMI observation inside the default lookback window. */
const recentBmi = (value: number, id = 'bmi1') =>
  observation(id, BMI, '2022-06-01T10:00:00Z', { value, unit: 'kg/m2' });

/** The two documentation requirements, satisfied. */
const weightLossDoc = codedResource(
  'Procedure',
  'wl1',
  { system: SNOMED, code: '229095001', display: 'Exercise class (regime/therapy)' },
  '2022-02-02T10:00:00Z',
);
const psychEvalDoc = codedResource(
  'Procedure',
  'ps1',
  {
    system: SNOMED,
    code: '79094001',
    display: 'Initial psychiatric interview with mental status and evaluation (procedure)',
  },
  '2022-03-03T10:00:00Z',
);

describe('the BMI arm', () => {
  it('qualifies on BMI alone at or above 40, without needing a comorbidity', () => {
    const assessment = assess([recentBmi(42.6)]);

    expect(requirement(assessment, 'bmi-threshold').status).toBe('met');
    // Not "met" — the record was never asked for a comorbidity, and claiming
    // one was found would be a different statement from "one was not needed".
    expect(requirement(assessment, 'comorbidity').status).toBe('not-applicable');
    expect(gaps(assessment)).toEqual([
      'no-weight-loss-documentation',
      'no-psychological-evaluation',
    ]);
  });

  it('leaves the 35–40 band unresolved when no comorbidity is coded', () => {
    const assessment = assess([recentBmi(36.2)]);

    expect(requirement(assessment, 'bmi-threshold').status).toBe('met');
    expect(requirement(assessment, 'comorbidity').status).toBe('unknown');
    expect(gaps(assessment)).toContain('no-comorbidity-recorded');
    // Never "not eligible": an uncoded comorbidity is a silent chart, not a
    // patient who has been shown to have none.
    expect(assessment.determination).toBe('unknown');
  });

  it('counts a comorbidity only when its code is in the policy set', () => {
    // `condition()` builds a SNOMED 111 code, which is in no policy set. The
    // display text says "Essential hypertension" — matching on it would pass.
    const byDisplay = assess([
      recentBmi(36.2),
      condition('c1', 'Essential hypertension (disorder)', 'active', '2015-01-01'),
    ]);
    expect(requirement(byDisplay, 'comorbidity').status).toBe('unknown');

    const byCode = assess([
      recentBmi(36.2),
      codedResource(
        'Condition',
        'c1',
        { system: SNOMED, code: '59621000', display: 'Essential hypertension (disorder)' },
        '2015-01-01',
        { clinicalStatus: { coding: [{ code: 'active' }] } },
      ),
    ]);
    expect(requirement(byCode, 'comorbidity').status).toBe('met');
  });

  it('rules a patient out only on a recorded BMI below the lower threshold', () => {
    const assessment = assess([recentBmi(28.4)]);

    expect(assessment.determination).toBe('not-eligible');
    expect(requirement(assessment, 'bmi-threshold').status).toBe('not-met');
    // Documentation is not chased for a patient the clinical criteria already
    // exclude, and the checklist says so rather than reporting a false gap.
    expect(requirement(assessment, 'weight-loss-attempts').status).toBe('not-applicable');
    expect(assessment.unknownReasons).toEqual([]);
  });

  it('reports a missing BMI as unknown, never as not eligible', () => {
    const assessment = assess([]);

    expect(assessment.determination).toBe('unknown');
    expect(gaps(assessment)).toContain('no-bmi-recorded');
    expect(requirement(assessment, 'bmi-threshold').rationale).toContain('39156-5');
  });

  it('treats a BMI older than the lookback window as unknown, not as current', () => {
    const assessment = assess([
      observation('old', BMI, '2015-04-02T10:00:00Z', { value: 44.1, unit: 'kg/m2' }),
    ]);

    expect(assessment.determination).toBe('unknown');
    expect(gaps(assessment)).toContain('bmi-outside-lookback');
    // The stale reading is still cited — the reviewer needs to see the number
    // they are being told not to rely on.
    expect(requirement(assessment, 'bmi-threshold').evidence[0]?.ref).toBe('Observation/old');
  });

  it('uses the most recent in-window reading, not the highest', () => {
    const assessment = assess([
      observation('a', BMI, '2021-06-01T10:00:00Z', { value: 43.0, unit: 'kg/m2' }),
      observation('b', BMI, '2022-06-01T10:00:00Z', { value: 31.0, unit: 'kg/m2' }),
    ]);

    expect(assessment.determination).toBe('not-eligible');
    expect(requirement(assessment, 'bmi-threshold').evidence[0]?.ref).toBe('Observation/b');
  });

  it('does not read a BMI percentile as a BMI', () => {
    // 59576-9 is a 0–100 paediatric percentile whose display contains "Body mass
    // index". Read as a BMI, an 82nd-percentile child clears the ≥ 40 arm.
    const assessment = assess([
      observation('pct', '59576-9', '2022-06-01T10:00:00Z', { value: 82, unit: '%' }),
    ]);

    expect(gaps(assessment)).toContain('no-bmi-recorded');
  });

  it('reports a BMI observation with no value as unusable rather than absent', () => {
    const assessment = assess([observation('novalue', BMI, '2022-06-01T10:00:00Z')]);

    expect(gaps(assessment)).toContain('bmi-value-unusable');
    expect(gaps(assessment)).not.toContain('no-bmi-recorded');
  });
});

describe('documentation requirements', () => {
  it('reaches eligible only when both documents are evidenced', () => {
    const assessment = assess([recentBmi(42.6), weightLossDoc, psychEvalDoc]);

    expect(assessment.determination).toBe('eligible');
    expect(assessment.unknownReasons).toEqual([]);
    expect(requirement(assessment, 'weight-loss-attempts').evidence[0]?.ref).toBe('Procedure/wl1');
    expect(requirement(assessment, 'psychological-evaluation').evidence[0]?.ref).toBe('Procedure/ps1');
  });

  it('stays unknown when only one document is present', () => {
    const assessment = assess([recentBmi(42.6), weightLossDoc]);

    expect(assessment.determination).toBe('unknown');
    expect(gaps(assessment)).toEqual(['no-psychological-evaluation']);
  });

  it('does not let a depression screen stand in for a psychological evaluation', () => {
    const assessment = assess([
      recentBmi(42.6),
      weightLossDoc,
      codedResource(
        'Observation',
        'phq',
        {
          system: LOINC,
          code: '44261-6',
          display: 'Patient Health Questionnaire 9 item (PHQ-9) total score [Reported]',
        },
        '2022-05-05T10:00:00Z',
      ),
    ]);

    expect(assessment.determination).toBe('unknown');
    expect(gaps(assessment)).toContain('no-psychological-evaluation');

    // The near-miss is surfaced with its caveat rather than hidden: "eleven
    // screens, none of them an evaluation" is a different next action from
    // "nothing on file".
    const psych = requirement(assessment, 'psychological-evaluation');
    expect(psych.relatedEvidence).toHaveLength(1);
    expect(psych.relatedEvidence[0]?.ref).toBe('Observation/phq');
    expect(psych.relatedEvidence[0]?.caveat).toContain('screening');
  });

  it('treats a dual-indication drug as ambiguous rather than as an attempt', () => {
    // Liraglutide 6 mg/mL is Victoza (type 2 diabetes) and Saxenda (weight
    // management) under one RxNorm code, so it cannot settle the question.
    const assessment = assess([
      recentBmi(42.6),
      psychEvalDoc,
      codedResource(
        'MedicationRequest',
        'med1',
        { system: RXNORM, code: '897122', display: '3 ML liraglutide 6 MG/ML Pen Injector' },
        '2022-04-04T10:00:00Z',
      ),
    ]);

    expect(assessment.determination).toBe('unknown');
    expect(gaps(assessment)).toEqual(['no-weight-loss-documentation']);

    const weightLoss = requirement(assessment, 'weight-loss-attempts');
    expect(weightLoss.status).toBe('unknown');
    expect(weightLoss.relatedEvidence[0]?.caveat).toContain('Dual-indication');
  });
});

describe('withdrawn and resolved records', () => {
  it('ignores a comorbidity that was resolved', () => {
    const assessment = assess([
      recentBmi(36.2),
      codedResource(
        'Condition',
        'c1',
        { system: SNOMED, code: '59621000', display: 'Essential hypertension (disorder)' },
        '2015-01-01',
        { clinicalStatus: { coding: [{ code: 'resolved' }] } },
      ),
    ]);

    expect(requirement(assessment, 'comorbidity').status).toBe('unknown');
  });

  it('ignores a comorbidity that was refuted', () => {
    const assessment = assess([
      recentBmi(36.2),
      codedResource(
        'Condition',
        'c1',
        { system: SNOMED, code: '44054006', display: 'Diabetes mellitus type 2 (disorder)' },
        '2015-01-01',
        {
          clinicalStatus: { coding: [{ code: 'active' }] },
          verificationStatus: { coding: [{ code: 'refuted' }] },
        },
      ),
    ]);

    expect(requirement(assessment, 'comorbidity').status).toBe('unknown');
  });

  it('ignores documentation entered in error', () => {
    const assessment = assess([
      recentBmi(42.6),
      psychEvalDoc,
      codedResource(
        'Procedure',
        'wl-bad',
        { system: SNOMED, code: '229095001', display: 'Exercise class (regime/therapy)' },
        '2022-02-02T10:00:00Z',
        { status: 'entered-in-error' },
      ),
    ]);

    expect(assessment.determination).toBe('unknown');
    expect(gaps(assessment)).toEqual(['no-weight-loss-documentation']);
    // Not surfaced as weak evidence either: the record says it never happened.
    expect(requirement(assessment, 'weight-loss-attempts').relatedEvidenceTotal).toBe(0);
  });
});

describe('the review date', () => {
  it('anchors to the store\'s newest clinical date when none is requested', () => {
    const db = buildFixtureStore([
      patient(),
      observation('bmi1', BMI, '2019-06-01T10:00:00Z', { value: 42.6, unit: 'kg/m2' }),
    ]);

    const assessment = assessPatient(db, 'p1');
    expect(assessment?.policy.asOfSource).toBe('store-latest-clinical-date');
    expect(assessment?.policy.asOf).toBe('2019-06-01');
    // Against the wall clock this 2019 reading would be stale; against the data
    // horizon it is the current one.
    expect(assessment?.requirements[0]?.status).toBe('met');
  });

  it('honours an explicit review date and reports it as requested', () => {
    const assessment = assess([recentBmi(42.6)], '2026-07-31');

    expect(assessment.policy.asOfSource).toBe('requested');
    expect(assessment.policy.lookbackStart).toBe('2024-07-31');
    expect(gaps(assessment)).toContain('bmi-outside-lookback');
  });

  it('clamps the lookback start rather than rolling into the next month', () => {
    // 31 March minus 24 months must be 31 March, and 31 May minus 3 months must
    // not become 3 March. A naive setUTCMonth does the latter.
    const assessment = assess([recentBmi(42.6)], '2023-03-31');
    expect(assessment.policy.lookbackStart).toBe('2021-03-31');
  });

  it('rejects a malformed review date instead of quietly defaulting', () => {
    const db = buildFixtureStore([patient()]);
    expect(() => assessPatient(db, 'p1', { requested: 'last-tuesday' })).toThrow(/YYYY-MM-DD/);
  });
});

describe('unknown patients', () => {
  it('returns undefined rather than an empty assessment', () => {
    const db = buildFixtureStore([patient()]);
    expect(assessPatient(db, 'no-such-patient')).toBeUndefined();
  });
});

describe('the cohort report', () => {
  const cohort = () => {
    const db = buildFixtureStore([
      // p1: eligible — BMI ≥ 40 with both documents.
      patient(),
      recentBmi(42.6),
      weightLossDoc,
      psychEvalDoc,
      // p2: not eligible — a recent BMI below 35.
      patient({ id: 'p2', name: [{ family: 'Okafor', given: ['Ada'] }] }),
      { ...observation('bmi2', BMI, '2022-06-01T10:00:00Z', { value: 24.0, unit: 'kg/m2' }),
        subject: { reference: 'Patient/p2' } },
      // p3: unknown — no BMI at all.
      patient({ id: 'p3', name: [{ family: 'Ilves', given: ['Kaur'] }] }),
      // p4: unknown — BMI in band, no comorbidity.
      patient({ id: 'p4', name: [{ family: 'Rana', given: ['Devi'] }] }),
      { ...observation('bmi4', BMI, '2022-06-01T10:00:00Z', { value: 37.0, unit: 'kg/m2' }),
        subject: { reference: 'Patient/p4' } },
    ]);
    return assessCohort(db, { requested: AS_OF }).report;
  };

  it('counts every patient into exactly one category', () => {
    const report = cohort();

    expect(report.totalPatients).toBe(4);
    const counts = Object.fromEntries(
      report.categories.map((entry) => [entry.determination, entry.count]),
    );
    expect(counts).toEqual({ eligible: 1, 'not-eligible': 1, unknown: 2 });
    expect(report.categories.reduce((sum, entry) => sum + entry.count, 0)).toBe(4);
  });

  it('reports percentages against the whole cohort', () => {
    const report = cohort();
    const eligible = report.categories.find((entry) => entry.determination === 'eligible');
    expect(eligible?.percent).toBe(25);
  });

  it('breaks unknowns down by reason, allowing a patient to carry several', () => {
    const report = cohort();
    const byReason = Object.fromEntries(
      report.unknownReasons.map((entry) => [entry.reason, entry.patients]),
    );

    expect(byReason['no-bmi-recorded']).toBe(1);
    expect(byReason['no-comorbidity-recorded']).toBe(1);
    // Both unknown patients are missing both documents.
    expect(byReason['no-weight-loss-documentation']).toBe(2);
    expect(byReason['no-psychological-evaluation']).toBe(2);
  });

  it('also groups unknowns by their exact set of gaps, mutually exclusively', () => {
    const report = cohort();

    expect(report.unknownCombinations.reduce((sum, entry) => sum + entry.patients, 0)).toBe(2);
    expect(report.unknownCombinations.map((entry) => entry.reasons.join('+'))).toEqual([
      'no-bmi-recorded+no-weight-loss-documentation+no-psychological-evaluation',
      'no-comorbidity-recorded+no-weight-loss-documentation+no-psychological-evaluation',
    ]);
  });

  it('agrees with the per-patient assessment for every patient', () => {
    const db = buildFixtureStore([
      patient(),
      recentBmi(42.6),
      weightLossDoc,
      psychEvalDoc,
      patient({ id: 'p2' }),
      { ...observation('bmi2', BMI, '2022-06-01T10:00:00Z', { value: 24.0, unit: 'kg/m2' }),
        subject: { reference: 'Patient/p2' } },
    ]);

    // The guard against the cohort report and the patient screen drifting apart:
    // both must come from the same evaluator over the same evidence.
    const { assessments } = assessCohort(db, { requested: AS_OF });
    for (const fromCohort of assessments) {
      const direct = assessPatient(db, fromCohort.patientId, { requested: AS_OF });
      expect(direct).toEqual(fromCohort);
    }
  });

  it('states which policy codes reach nothing in this store', () => {
    const report = cohort();
    const reachable = report.codeCoverage.filter((entry) => entry.resources > 0);

    // The fixture contains three policy-coded resources: BMI, exercise class,
    // psychiatric interview. Everything else in the policy reaches nothing here.
    expect(reachable.map((entry) => entry.code).sort()).toEqual([
      '229095001',
      '39156-5',
      '79094001',
    ]);
    expect(report.codeCoverage.length + report.unmatchedPolicyCodes.length).toBe(
      // Every code the policy mentions, across all six sets.
      1 +
        BARIATRIC_POLICY.comorbidity.accepted.length +
        BARIATRIC_POLICY.comorbidity.related.length +
        BARIATRIC_POLICY.weightLoss.accepted.length +
        BARIATRIC_POLICY.weightLoss.related.length +
        BARIATRIC_POLICY.psychEvaluation.accepted.length +
        BARIATRIC_POLICY.psychEvaluation.related.length,
    );
  });
});
