/**
 * The bariatric surgery coverage policy, expressed as data.
 *
 * The policy lives here rather than inside the evaluator for three reasons:
 *
 *  - It is the thing a reviewer will argue with. Thresholds, lookback windows
 *    and — above all — *which codes count as a comorbidity* are clinical policy
 *    decisions, not implementation details, and they should be readable without
 *    reading the algorithm.
 *  - Part D must not be able to change an outcome. A model can only ever be
 *    handed the result of applying this file; it never gets to pick codes.
 *  - Every code below is matched on `(system, code)`, never on display text.
 *    See `query/codes.ts` for the concrete case where a substring match on a
 *    label reads a BMI *percentile* as a BMI.
 *
 * ## What "evidence" means here
 *
 * Each documentation requirement has two code sets. `accepted` codes satisfy
 * the requirement. `related` codes are things a reviewer would want to see but
 * which do **not** satisfy it — a two-question depression screen is not a
 * psychological evaluation for surgical clearance. Related codes can never
 * promote a requirement to `met`; they exist so that "unknown" comes with the
 * near-misses attached, which is what makes the gap actionable instead of just
 * discouraging.
 *
 * ## Deliberately narrow
 *
 * Every code in the accepted sets was verified to exist in this export, and no
 * code was included that could not be verified. A production deployment would
 * extend these sets considerably — structured dietician referrals, medically
 * supervised weight-management program enrolments, anti-obesity pharmacotherapy
 * (orlistat, phentermine/topiramate, naltrexone-bupropion, semaglutide 2.4 mg),
 * and formal behavioural-health evaluations — but inventing plausible-looking
 * codes for concepts this dataset does not contain would make the code set look
 * more authoritative than it is. `PolicyCodeCoverage` reports which policy codes
 * actually matched rows in the store, so the narrowness is measurable rather
 * than assumed.
 */

export const SNOMED = 'http://snomed.info/sct';
export const LOINC = 'http://loinc.org';
export const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

/** One code in a policy code set. `display` is documentation, never a matcher. */
export interface PolicyCode {
  system: string;
  code: string;
  display: string;
  /** Why this code is in (or excluded from) the set, when that is not obvious. */
  note?: string;
}

/** A named set of codes, with the reasoning that produced it. */
export interface CodeSet {
  /** Codes that satisfy the requirement. */
  accepted: readonly PolicyCode[];
  /**
   * Codes that are clinically adjacent but insufficient. Surfaced as context on
   * an `unknown` finding; never enough to make a requirement `met`.
   */
  related: readonly PolicyCode[];
}

/**
 * Obesity-related comorbidities.
 *
 * The policy text says "at least one comorbidity (e.g. hypertension, type 2
 * diabetes)", so the set is the established obesity-related conditions, taken
 * to include the coded *complications* of type 2 diabetes: a record that says
 * "diabetic neuropathy" and never separately says "diabetes" still evidences
 * diabetes, and dropping those rows would under-count real comorbidity.
 *
 * Three codes present in this export are deliberately **excluded**, because
 * counting them would inflate the comorbidity arm with things that are not
 * comorbidities:
 *  - `714628002` Prediabetes — not type 2 diabetes, and the policy names T2DM.
 *  - `162864005` Body mass index 30+ - obesity — that is the obesity itself.
 *  - `408512008` Body mass index 40+ - severely obese — likewise, and it would
 *    make the comorbidity arm circular with the BMI arm.
 */
const COMORBIDITY: CodeSet = {
  accepted: [
    { system: SNOMED, code: '59621000', display: 'Essential hypertension (disorder)' },
    { system: SNOMED, code: '44054006', display: 'Diabetes mellitus type 2 (disorder)' },
    {
      system: SNOMED,
      code: '127013003',
      display: 'Disorder of kidney due to diabetes mellitus (disorder)',
      note: 'Coded complication of type 2 diabetes.',
    },
    {
      system: SNOMED,
      code: '90781000119102',
      display: 'Microalbuminuria due to type 2 diabetes mellitus (disorder)',
      note: 'Coded complication of type 2 diabetes.',
    },
    {
      system: SNOMED,
      code: '157141000119108',
      display: 'Proteinuria due to type 2 diabetes mellitus (disorder)',
      note: 'Coded complication of type 2 diabetes.',
    },
    {
      system: SNOMED,
      code: '368581000119106',
      display: 'Neuropathy due to type 2 diabetes mellitus (disorder)',
      note: 'Coded complication of type 2 diabetes.',
    },
    {
      system: SNOMED,
      code: '1551000119108',
      display: 'Nonproliferative diabetic retinopathy due to type II diabetes mellitus',
      note: 'Coded complication of type 2 diabetes.',
    },
    {
      system: SNOMED,
      code: '1501000119109',
      display: 'Proliferative diabetic retinopathy due to type II diabetes mellitus',
      note: 'Coded complication of type 2 diabetes.',
    },
    {
      system: SNOMED,
      code: '97331000119101',
      display: 'Macular edema and retinopathy due to type 2 diabetes mellitus (disorder)',
      note: 'Coded complication of type 2 diabetes.',
    },
    { system: SNOMED, code: '78275009', display: 'Obstructive sleep apnea syndrome (disorder)' },
    { system: SNOMED, code: '73430006', display: 'Sleep apnea (disorder)' },
    { system: SNOMED, code: '55822004', display: 'Hyperlipidemia (disorder)' },
    { system: SNOMED, code: '237602007', display: 'Metabolic syndrome X (disorder)' },
    { system: SNOMED, code: '414545008', display: 'Ischemic heart disease (disorder)' },
    { system: SNOMED, code: '88805009', display: 'Chronic congestive heart failure (disorder)' },
    { system: SNOMED, code: '84114007', display: 'Heart failure (disorder)' },
    {
      system: SNOMED,
      code: '239873007',
      display: 'Osteoarthritis of knee (disorder)',
      note: 'Weight-bearing joint; hand osteoarthritis is not in the set.',
    },
    { system: SNOMED, code: '239872002', display: 'Osteoarthritis of hip (disorder)' },
    { system: SNOMED, code: '235595009', display: 'Gastroesophageal reflux disease (disorder)' },
  ],
  related: [
    {
      system: SNOMED,
      code: '714628002',
      display: 'Prediabetes (finding)',
      note: 'Not type 2 diabetes. Shown as context, never counted.',
    },
    {
      system: SNOMED,
      code: '162864005',
      display: 'Body mass index 30+ - obesity (finding)',
      note: 'The obesity itself, not a comorbidity of it.',
    },
    {
      system: SNOMED,
      code: '408512008',
      display: 'Body mass index 40+ - severely obese (finding)',
      note: 'The obesity itself, not a comorbidity of it.',
    },
  ],
};

/**
 * Evidence of prior weight-loss attempts.
 *
 * `897122` is the interesting one and the reason `related` exists. That RxNorm
 * code is a 3 mL liraglutide 6 mg/mL pen — the *same product code* is marketed
 * as Victoza for type 2 diabetes and as Saxenda for weight management. A
 * prescription for it is therefore genuinely ambiguous: it may evidence a
 * supervised weight-loss attempt, or it may simply be diabetes treatment. It is
 * surfaced with that ambiguity stated rather than silently counted either way,
 * which is the honest handling of conflicting evidence.
 */
const WEIGHT_LOSS: CodeSet = {
  accepted: [
    {
      system: SNOMED,
      code: '229095001',
      display: 'Exercise class (regime/therapy)',
      note: 'A structured, clinician-recorded exercise intervention.',
    },
  ],
  related: [
    {
      system: RXNORM,
      code: '897122',
      display: '3 ML liraglutide 6 MG/ML Pen Injector',
      note:
        'Dual-indication product: liraglutide 6 mg/mL is Victoza (type 2 diabetes) and ' +
        'Saxenda (weight management) under the same code. Cannot be read as a weight-loss ' +
        'attempt on its own.',
    },
  ],
};

/**
 * Psychological evaluation.
 *
 * The bar is a clinician-performed psychological or psychiatric evaluation, not
 * a screening instrument. That distinction does almost all the work in this
 * dataset: 938 of 1,132 patients have a `171207006` depression screening and
 * 527 have a PHQ-9, but a PHQ-9 is a nine-question depression score, not the
 * behavioural-health assessment a bariatric surgery authorization requires.
 * Accepting screens would mark most of the cohort as documented on the strength
 * of evidence no reviewer would accept — the exact false-confidence failure the
 * brief is testing for.
 */
const PSYCH_EVALUATION: CodeSet = {
  accepted: [
    {
      system: SNOMED,
      code: '79094001',
      display: 'Initial psychiatric interview with mental status and evaluation (procedure)',
    },
    {
      system: SNOMED,
      code: '200619008',
      display: 'Comprehensive interview and evaluation (procedure)',
    },
  ],
  related: [
    {
      system: SNOMED,
      code: '385892002',
      display: 'Mental health screening (procedure)',
      note: 'A screen, not an evaluation.',
    },
    {
      system: SNOMED,
      code: '171207006',
      display: 'Depression screening (procedure)',
      note: 'A screen, not an evaluation.',
    },
    {
      system: SNOMED,
      code: '715252007',
      display: 'Depression screening using Patient Health Questionnaire Nine Item score (procedure)',
      note: 'A screen, not an evaluation.',
    },
    {
      system: LOINC,
      code: '44261-6',
      display: 'Patient Health Questionnaire 9 item (PHQ-9) total score [Reported]',
      note: 'A screening score, not an evaluation.',
    },
    {
      system: SNOMED,
      code: '228557008',
      display: 'Cognitive and behavioral therapy (regime/therapy)',
      note: 'Treatment rather than evaluation, but strong evidence of behavioural-health contact.',
    },
    {
      system: SNOMED,
      code: '408919008',
      display: 'Psychosocial care (regime/therapy)',
      note: 'Treatment rather than evaluation.',
    },
    {
      system: LOINC,
      code: '75443-2',
      display: 'Mental health Outpatient Note',
      note: 'A note of a mental-health contact; does not state that an evaluation was performed.',
    },
    {
      system: LOINC,
      code: '84215-3',
      display: 'Mental health Telehealth Note',
      note: 'A note of a mental-health contact; does not state that an evaluation was performed.',
    },
  ],
};

/**
 * The BMI observation.
 *
 * One code, and only one: `39156-5` is the BMI ratio in kg/m². `59576-9`
 * ("Body mass index (BMI) [Percentile] Per age and sex") shares the words "body
 * mass index" but is a 0–100 paediatric percentile, and reading one as the other
 * turns an 82nd-percentile child into a BMI of 82.
 */
const BMI_CODE: PolicyCode = {
  system: LOINC,
  code: '39156-5',
  display: 'Body mass index (BMI) [Ratio]',
};

/** The unit a BMI must be recorded in for its number to mean what we think. */
const BMI_UNIT = 'kg/m2';

export interface Policy {
  id: string;
  version: string;
  label: string;
  /** BMI at or above this qualifies on its own. */
  bmiSoleThreshold: number;
  /** BMI at or above this qualifies only with a comorbidity. */
  bmiWithComorbidityThreshold: number;
  /**
   * How recent the BMI must be, in months before the assessment date.
   *
   * The policy text does not state a window; this one is the tool's, and it is
   * a parameter precisely so a reviewer can see it and change it. A BMI from
   * 1972 is a fact about a patient's past, not a basis for authorizing surgery,
   * and treating it as current is the failure mode this guards against.
   */
  observationLookbackMonths: number;
  bmi: { code: PolicyCode; expectedUnit: string };
  comorbidity: CodeSet;
  weightLoss: CodeSet;
  psychEvaluation: CodeSet;
}

export const BARIATRIC_POLICY: Policy = {
  id: 'bariatric-surgery',
  version: '1.0.0',
  label: 'Simplified bariatric surgery coverage policy',
  bmiSoleThreshold: 40,
  bmiWithComorbidityThreshold: 35,
  observationLookbackMonths: 24,
  bmi: { code: BMI_CODE, expectedUnit: BMI_UNIT },
  comorbidity: COMORBIDITY,
  weightLoss: WEIGHT_LOSS,
  psychEvaluation: PSYCH_EVALUATION,
};

/** Which code set a matched coding belongs to. */
export type CodeSetId =
  | 'bmi'
  | 'comorbidity'
  | 'comorbidity-related'
  | 'weight-loss'
  | 'weight-loss-related'
  | 'psych-evaluation'
  | 'psych-evaluation-related';

/** Every code the policy mentions, tagged with the set it came from. */
export function policyCodes(policy: Policy): { setId: CodeSetId; code: PolicyCode }[] {
  const tagged: { setId: CodeSetId; code: PolicyCode }[] = [
    { setId: 'bmi', code: policy.bmi.code },
  ];
  const sets: [CodeSetId, CodeSetId, CodeSet][] = [
    ['comorbidity', 'comorbidity-related', policy.comorbidity],
    ['weight-loss', 'weight-loss-related', policy.weightLoss],
    ['psych-evaluation', 'psych-evaluation-related', policy.psychEvaluation],
  ];
  for (const [acceptedId, relatedId, set] of sets) {
    for (const code of set.accepted) tagged.push({ setId: acceptedId, code });
    for (const code of set.related) tagged.push({ setId: relatedId, code });
  }
  return tagged;
}
