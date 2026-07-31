/**
 * The cohort eligibility report.
 *
 * Built by running the *same* evaluator over every patient rather than by
 * writing aggregate SQL. Aggregate SQL would be faster, and it would also be a
 * second implementation of the policy that could silently drift from the one on
 * the patient screen — a cohort report that disagrees with the patient it is
 * summarising is worse than no cohort report. The evidence for all 1,132
 * patients is gathered in three queries and evaluated in memory, which keeps the
 * whole report well under a second while leaving exactly one copy of the logic.
 *
 * ## Two breakdowns of `unknown`, not one
 *
 * The brief asks for "top reasons for unknown status". Counted per reason, the
 * rows overlap: a patient missing both documents appears twice, so the
 * percentages sum past 100 and the table answers "how common is this gap"
 * without answering "how close is this patient to a decision".
 * `unknownCombinations` answers the second by grouping patients on their exact
 * set of gaps — a one-reason combination is a single document away from a
 * determination, which is the actionable population.
 */
import type { Db } from '../store/db.js';
import type {
  CohortCategory,
  CohortContext,
  CohortReport,
  CohortUnknownCombination,
  CohortUnknownReason,
  Determination,
  EligibilityAssessment,
  PolicyCodeCoverage,
  PolicySummary,
  UnknownReason,
} from './dto.js';
import type { Policy } from './policy.js';
import { BARIATRIC_POLICY } from './policy.js';
import type { CodingReach, ResolvedCodes } from './evidence.js';
import {
  gatherCohortEvidence,
  gatherPatientEvidence,
  latestClinicalDate,
  resolveCodes,
} from './evidence.js';
import { evaluateEligibility, resolveAsOf, UNKNOWN_REASON_LABELS } from './evaluate.js';
import type { AsOfOptions } from './evaluate.js';

/** Every determination, so a category with no patients still appears as 0. */
const DETERMINATIONS: readonly Determination[] = ['eligible', 'not-eligible', 'unknown'];

/** One decimal place, and never `NaN` for an empty cohort. */
function percent(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Per-code reach into the store, from the counts the gather already produced.
 *
 * Counted over the whole store rather than over the cohort, because the question
 * it answers is "does this export contain anything this code could match" — and
 * a code whose only rows belong to the 1,143 subjects with no Patient resource
 * is still a code the policy cannot use.
 */
function codeCoverage(resolved: ResolvedCodes, reach: Map<number, CodingReach>): PolicyCodeCoverage[] {
  return [...resolved.byCodingId.entries()]
    .map(([codingId, entry]): PolicyCodeCoverage => {
      const counts = reach.get(codingId);
      return {
        setId: entry.setId,
        system: entry.code.system,
        code: entry.code.code,
        display: entry.code.display,
        patients: counts?.patients ?? 0,
        resources: counts?.resources ?? 0,
      };
    })
    .sort((a, b) => b.patients - a.patients || a.code.localeCompare(b.code));
}

/** Subjects referenced by a resource but with no Patient resource in the export. */
function countDanglingSubjects(db: Db): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n
         FROM (SELECT DISTINCT patient_id FROM resource WHERE patient_id IS NOT NULL) AS referenced
        WHERE NOT EXISTS (SELECT 1 FROM patient WHERE patient.id = referenced.patient_id)`,
    )
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Reads the context counters that come straight off the patient table. */
function countDeceased(db: Db): number {
  const row = db.prepare('SELECT count(*) AS n FROM patient WHERE deceased = 1').get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

export interface CohortOptions extends AsOfOptions {
  policy?: Policy;
}

export interface CohortResult {
  report: CohortReport;
  assessments: EligibilityAssessment[];
}

/**
 * Memo of computed reports, per connection and review date.
 *
 * The store is written once by the ingest and opened read-only by everything
 * else, so a report for a given `asOf` cannot go stale while the process runs —
 * which makes this a cache with no invalidation problem rather than one whose
 * invalidation was skipped. Without it the API pays a full 1.8 s sweep every
 * time the cohort tab is opened.
 *
 * Keyed by the `Db` through a `WeakMap` rather than globally: the tests build a
 * fresh in-memory store per case, and a cache keyed on `asOf` alone would hand
 * one test's cohort to the next.
 */
const REPORT_CACHE = new WeakMap<Db, Map<string, CohortResult>>();

/** Cache key: everything about the request that can change the answer. */
function cacheKey(options: CohortOptions): string | undefined {
  // A caller-supplied policy is not part of the key, so it is not cached at all
  // — a bespoke policy is a one-off, and hashing code sets to memoize it would
  // cost more than the sweep it saves.
  if (options.policy !== undefined) return undefined;
  return `${options.requested ?? ''}|${options.storeLatest ?? ''}|${options.now?.getTime() ?? ''}`;
}

/**
 * Evaluates every patient and returns both the assessments and the report.
 *
 * The assessments are returned alongside the report because the callers that
 * want the report usually want to drill into it — the CLI prints example
 * patients, and returning them costs nothing since they were computed anyway.
 */
export function assessCohort(db: Db, options: CohortOptions = {}): CohortResult {
  const key = cacheKey(options);
  if (key !== undefined) {
    const cached = REPORT_CACHE.get(db)?.get(key);
    if (cached) return cached;
  }

  const result = computeCohort(db, options);

  if (key !== undefined) {
    let perDb = REPORT_CACHE.get(db);
    if (!perDb) {
      perDb = new Map();
      REPORT_CACHE.set(db, perDb);
    }
    perDb.set(key, result);
  }
  return result;
}

function computeCohort(db: Db, options: CohortOptions): CohortResult {
  const startedAt = process.hrtime.bigint();
  const policy = options.policy ?? BARIATRIC_POLICY;
  const resolved = resolveCodes(db, policy);
  const storeLatest = latestClinicalDate(db);

  const summary = resolveAsOf(policy, { ...options, storeLatest: options.storeLatest ?? storeLatest });

  const { byPatient, reach } = gatherCohortEvidence(db, policy, resolved);
  const assessments = [...byPatient.values()].map((evidence) =>
    evaluateEligibility(evidence, policy, summary),
  );

  const report = summarise(db, summary, resolved, reach, assessments, storeLatest);
  report.computeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { report, assessments };
}

/** Folds a list of assessments into the report shape. */
function summarise(
  db: Db,
  summary: PolicySummary,
  resolved: ResolvedCodes,
  reach: Map<number, CodingReach>,
  assessments: EligibilityAssessment[],
  storeLatest: number | undefined,
): CohortReport {
  const total = assessments.length;

  const byDetermination = new Map<Determination, number>();
  const byReason = new Map<UnknownReason, number>();
  const byCombination = new Map<string, { reasons: UnknownReason[]; patients: number }>();

  const context: CohortContext = {
    patientsWithAnyBmi: 0,
    patientsWithBmiInWindow: 0,
    patientsMeetingBmiSoleThreshold: 0,
    patientsMeetingBmiWithComorbidity: 0,
    patientsInBmiBandWithoutComorbidity: 0,
    patientsWithWeightLossDocumentation: 0,
    patientsWithPsychEvaluation: 0,
    patientsWithBothDocuments: 0,
    deceasedPatients: countDeceased(db),
    storeLatestClinicalDate: storeLatest === undefined ? null : new Date(storeLatest).toISOString().slice(0, 10),
  };

  let unknownTotal = 0;

  for (const assessment of assessments) {
    byDetermination.set(
      assessment.determination,
      (byDetermination.get(assessment.determination) ?? 0) + 1,
    );

    const [bmi, comorbidity, weightLoss, psych] = assessment.requirements;

    // "Has any BMI" is the union of every way the BMI arm can have seen one:
    // a usable recent reading, a stale one, or one with no usable value.
    if (bmi && bmi.gap !== 'no-bmi-recorded') context.patientsWithAnyBmi += 1;
    if (bmi?.status === 'met' || bmi?.status === 'not-met') {
      context.patientsWithBmiInWindow += 1;
      if (comorbidity?.status === 'not-applicable' && bmi.status === 'met') {
        context.patientsMeetingBmiSoleThreshold += 1;
      } else if (comorbidity?.status === 'met') {
        context.patientsMeetingBmiWithComorbidity += 1;
      } else if (comorbidity?.status === 'unknown') {
        context.patientsInBmiBandWithoutComorbidity += 1;
      }
    }

    // Counted on evidence, not on `status`. A patient ruled out on BMI has
    // their documentation requirements marked `not-applicable` — the evidence is
    // still attached, and a coverage counter that skipped them would describe
    // the subset that was assessed rather than the cohort's actual records.
    const hasWeightLoss = (weightLoss?.evidence.length ?? 0) > 0;
    const hasPsych = (psych?.evidence.length ?? 0) > 0;
    if (hasWeightLoss) context.patientsWithWeightLossDocumentation += 1;
    if (hasPsych) context.patientsWithPsychEvaluation += 1;
    if (hasWeightLoss && hasPsych) context.patientsWithBothDocuments += 1;

    if (assessment.determination !== 'unknown') continue;
    unknownTotal += 1;

    const reasons = assessment.unknownReasons.map((entry) => entry.reason);
    for (const reason of reasons) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);

    // Reasons already come in requirement order, so the key is stable without
    // sorting and the combination reads in the order a reviewer would work it.
    const key = reasons.join('+');
    const bucket = byCombination.get(key);
    if (bucket) bucket.patients += 1;
    else byCombination.set(key, { reasons, patients: 1 });
  }

  const categories: CohortCategory[] = DETERMINATIONS.map((determination) => {
    const count = byDetermination.get(determination) ?? 0;
    return { determination, count, percent: percent(count, total) };
  });

  const unknownReasons: CohortUnknownReason[] = [...byReason.entries()]
    .map(([reason, patients]): CohortUnknownReason => ({
      reason,
      label: UNKNOWN_REASON_LABELS[reason],
      patients,
      percentOfUnknown: percent(patients, unknownTotal),
      percentOfCohort: percent(patients, total),
    }))
    .sort((a, b) => b.patients - a.patients || a.reason.localeCompare(b.reason));

  const unknownCombinations: CohortUnknownCombination[] = [...byCombination.values()]
    .map((entry): CohortUnknownCombination => ({
      reasons: entry.reasons,
      patients: entry.patients,
      percentOfUnknown: percent(entry.patients, unknownTotal),
    }))
    .sort((a, b) => b.patients - a.patients || a.reasons.length - b.reasons.length);

  return {
    policy: summary,
    totalPatients: total,
    categories,
    unknownReasons,
    unknownCombinations,
    context,
    codeCoverage: codeCoverage(resolved, reach),
    unmatchedPolicyCodes: resolved.unmatched.map((entry) => ({
      setId: entry.setId,
      system: entry.code.system,
      code: entry.code.code,
      display: entry.code.display,
    })),
    danglingSubjectPatients: countDanglingSubjects(db),
    computeMs: 0,
  };
}

/** Assesses one patient, or `undefined` when the id is unknown to the store. */
export function assessPatient(
  db: Db,
  patientId: string,
  options: CohortOptions = {},
): EligibilityAssessment | undefined {
  const policy = options.policy ?? BARIATRIC_POLICY;
  const resolved = resolveCodes(db, policy);
  const storeLatest = latestClinicalDate(db);
  const summary = resolveAsOf(policy, { ...options, storeLatest: options.storeLatest ?? storeLatest });

  // The same gather and the same evaluator the cohort runs — the single-patient
  // path differs only in how much evidence it reads.
  const evidence = gatherPatientEvidence(db, policy, patientId, resolved);
  return evidence === undefined ? undefined : evaluateEligibility(evidence, policy, summary);
}
