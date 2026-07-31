/**
 * The deterministic eligibility evaluator.
 *
 * A pure function of (evidence, policy, as-of date). No database handle, no
 * clock, no I/O — which is what makes it the same computation for one patient
 * on screen and for 1,132 patients in the cohort report, and what lets Part D
 * treat its output as a fixed floor it may describe but not move.
 *
 * ## The three-valued core
 *
 * Every requirement resolves to `met`, `not-met`, `unknown` or `not-applicable`,
 * and the determination is a fold over those. The rule that shapes the whole
 * design is that **absence of evidence is not evidence of absence**:
 *
 *  - A recorded BMI of 28 positively establishes that the patient fails both
 *    arms of the policy, so it produces `not eligible`.
 *  - A patient with *no* coded comorbidity has not been shown to lack one — the
 *    record simply does not say. That produces `unknown`, never `not eligible`.
 *
 * The consequence is deliberate and worth stating plainly: in this tool, only a
 * BMI measurement can rule a patient out. Everything else can only fail to rule
 * them in. That is the conservative direction for a prior-authorization review,
 * where a wrong `not eligible` denies care on the strength of a gap in the chart.
 *
 * ## Requirements are assessed only when they can be answered
 *
 * Comorbidity is evaluated only when the BMI lands in the 35–40 band, because
 * that is the only case where the answer changes the outcome. When BMI is ≥ 40
 * it is not required; when BMI is below 35 the criteria already fail; when BMI
 * is unknown we cannot yet tell which of those applies. In all three cases the
 * requirement reports `not-applicable` with the reason — and still carries any
 * comorbidity evidence found, so the reviewer sees it — rather than adding a
 * gap that is not actually standing in the way. Without this, the cohort's
 * "top reasons for unknown" would be dominated by comorbidity gaps belonging to
 * patients whose real problem is a missing BMI.
 */
import type {
  Determination,
  EligibilityAssessment,
  EvidenceItem,
  PolicySummary,
  RequirementFinding,
  RequirementId,
  UnknownReason,
} from './dto.js';
import type { BmiReading, CodedHit, PatientEvidence } from './evidence.js';
import type { CodeSetId, Policy } from './policy.js';
import { toDateInfo } from '../query/hydrate.js';

/**
 * How many near-miss resources a finding carries.
 *
 * 938 of 1,132 patients have depression screenings; a finding that listed all
 * of one patient's would be unreadable. `relatedEvidenceTotal` keeps the real
 * count, so the cap truncates the list without hiding its size.
 */
const RELATED_EVIDENCE_LIMIT = 3;

/** Human labels for the closed reason vocabulary, shared by the UI and the CLI. */
export const UNKNOWN_REASON_LABELS: Record<UnknownReason, string> = {
  'no-bmi-recorded': 'No BMI observation recorded',
  'bmi-outside-lookback': 'BMI not recent enough',
  'bmi-value-unusable': 'BMI recorded without a usable value',
  'no-comorbidity-recorded': 'No qualifying comorbidity recorded',
  'no-weight-loss-documentation': 'No evidence of prior weight-loss attempts',
  'no-psychological-evaluation': 'No psychological evaluation',
};

const REQUIREMENT_LABELS: Record<RequirementId, string> = {
  'bmi-threshold': 'BMI threshold',
  comorbidity: 'Comorbidity present',
  'weight-loss-attempts': 'Evidence of prior weight-loss attempts',
  'psychological-evaluation': 'Psychological evaluation',
};

/** `YYYY-MM-DD` in UTC. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Subtracts whole months, clamping the day of month.
 *
 * Naively calling `setUTCMonth(month - n)` on the 31st rolls forward into the
 * next month (31 March minus one month becomes 3 March), which would silently
 * widen or narrow the lookback window depending on the date it was run.
 */
function subtractMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const daysInMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, daysInMonth));
  return date.getTime();
}

export interface AsOfOptions {
  /** An explicit review date, `YYYY-MM-DD`. Wins over everything else. */
  requested?: string;
  /** The store's newest clinical date, from `latestClinicalDate`. */
  storeLatest?: number;
  /** Wall clock, injected for testability. */
  now?: Date;
}

/**
 * Chooses the date the assessment is made as of.
 *
 * The default is the store's own data horizon, not the wall clock, and that is
 * a considered choice rather than a convenience. This export is a static
 * historical snapshot whose newest clinical record is from April 2023. Scored
 * against today, *every* patient's BMI is outside any sane lookback window, and
 * the report would say "1,089 patients have a stale BMI" — a true sentence that
 * describes the age of the file and tells a reviewer nothing about the patients.
 * Anchoring to the data horizon asks the question the policy is actually about:
 * was this patient's BMI current *at the time the record was being kept*?
 *
 * The choice is never hidden: `asOfSource` travels with every assessment and is
 * printed on the report, and `requested` overrides it, so scoring the cohort
 * against today is one query parameter away.
 */
export function resolveAsOf(policy: Policy, options: AsOfOptions = {}): PolicySummary {
  let asOfMs: number;
  let asOfSource: PolicySummary['asOfSource'];

  if (options.requested !== undefined) {
    const parsed = Date.parse(`${options.requested}T00:00:00Z`);
    if (Number.isNaN(parsed)) {
      throw new Error(`asOf must be a YYYY-MM-DD date, got "${options.requested}"`);
    }
    asOfMs = parsed;
    asOfSource = 'requested';
  } else if (options.storeLatest !== undefined) {
    asOfMs = options.storeLatest;
    asOfSource = 'store-latest-clinical-date';
  } else {
    asOfMs = (options.now ?? new Date()).getTime();
    asOfSource = 'clock';
  }

  return {
    id: policy.id,
    version: policy.version,
    label: policy.label,
    bmiSoleThreshold: policy.bmiSoleThreshold,
    bmiWithComorbidityThreshold: policy.bmiWithComorbidityThreshold,
    observationLookbackMonths: policy.observationLookbackMonths,
    asOf: isoDay(asOfMs),
    asOfSource,
    lookbackStart: isoDay(subtractMonths(asOfMs, policy.observationLookbackMonths)),
  };
}

/** The window boundaries as millis, recovered from the summary the caller sees. */
function windowBounds(summary: PolicySummary): { asOfMs: number; startMs: number } {
  return {
    asOfMs: Date.parse(`${summary.asOf}T23:59:59.999Z`),
    startMs: Date.parse(`${summary.lookbackStart}T00:00:00Z`),
  };
}

function bmiEvidence(reading: BmiReading): EvidenceItem {
  return {
    ref: reading.ref,
    id: reading.id,
    resourceType: 'Observation',
    display: 'Body mass index (BMI) [Ratio]',
    date: toDateInfo(reading.date),
    matchedCode: {
      system: 'http://loinc.org',
      code: '39156-5',
      display: 'Body mass index (BMI) [Ratio]',
    },
    value:
      reading.value === null
        ? null
        : `${reading.value}${reading.unit ? ` ${reading.unit}` : ''}`,
  };
}

function hitEvidence(hit: CodedHit, caveat?: string): EvidenceItem {
  const item: EvidenceItem = {
    ref: hit.ref,
    id: hit.id,
    resourceType: hit.resourceType,
    display: hit.display,
    date: toDateInfo(hit.date),
    matchedCode: {
      system: hit.matchedCode.system,
      code: hit.matchedCode.code,
      display: hit.matchedCode.display,
    },
    value: null,
  };
  if (caveat !== undefined) item.caveat = caveat;
  return item;
}

/** Picks the hits belonging to one code set, newest first (the gather order). */
function hitsIn(evidence: PatientEvidence, setId: CodeSetId): CodedHit[] {
  return evidence.hits.filter((hit) => hit.setId === setId);
}

/** Builds the capped related-evidence list plus its true total. */
function related(hits: CodedHit[]): { relatedEvidence: EvidenceItem[]; relatedEvidenceTotal: number } {
  return {
    relatedEvidence: hits
      .slice(0, RELATED_EVIDENCE_LIMIT)
      .map((hit) => hitEvidence(hit, hit.matchedCode.note)),
    relatedEvidenceTotal: hits.length,
  };
}

/** What the BMI arm concluded, kept separately because later arms depend on it. */
interface BmiOutcome {
  finding: RequirementFinding;
  /** The reading the decision was made from, when there was a usable recent one. */
  reading: BmiReading | null;
  /** True when the reading alone clears the policy (≥ the sole threshold). */
  qualifiesAlone: boolean;
  /** True when the reading is in the band that requires a comorbidity. */
  needsComorbidity: boolean;
}

function evaluateBmi(
  evidence: PatientEvidence,
  policy: Policy,
  summary: PolicySummary,
): BmiOutcome {
  const { startMs } = windowBounds(summary);
  const base = {
    id: 'bmi-threshold' as const,
    label: REQUIREMENT_LABELS['bmi-threshold'],
    relatedEvidence: [],
    relatedEvidenceTotal: 0,
  };
  const none = { reading: null, qualifiesAlone: false, needsComorbidity: false };

  if (evidence.bmiReadings.length === 0) {
    return {
      ...none,
      finding: {
        ...base,
        status: 'unknown',
        rationale:
          `No Observation with LOINC ${policy.bmi.code.code} (BMI) exists for this patient, ` +
          'so neither arm of the policy can be tested.',
        evidence: [],
        gap: 'no-bmi-recorded',
      },
    };
  }

  // A reading is usable when it carries a number *and* that number is on the
  // scale we think it is. A BMI recorded in some other unit is not a BMI we can
  // compare to 40.
  const usable = evidence.bmiReadings.filter(
    (reading) =>
      reading.value !== null && (reading.unit === null || reading.unit === policy.bmi.expectedUnit),
  );

  if (usable.length === 0) {
    return {
      ...none,
      finding: {
        ...base,
        status: 'unknown',
        rationale:
          `${evidence.bmiReadings.length} BMI observation(s) exist, but none carries a numeric ` +
          `value in ${policy.bmi.expectedUnit}.`,
        evidence: evidence.bmiReadings.slice(0, RELATED_EVIDENCE_LIMIT).map(bmiEvidence),
        gap: 'bmi-value-unusable',
      },
    };
  }

  // Gathered newest-first with undated last, so the first in-window reading is
  // the most recent one.
  const current = usable.find(
    (reading) => reading.sortKey !== null && reading.sortKey >= startMs,
  );

  if (!current) {
    const latest = usable[0] as BmiReading;
    const rendered = `${latest.value}${latest.unit ? ` ${latest.unit}` : ''}`;
    return {
      ...none,
      finding: {
        ...base,
        status: 'unknown',
        rationale:
          latest.date === undefined
            ? `The most recent usable BMI (${rendered}) carries no date, so it cannot be shown to ` +
              `fall inside the ${policy.observationLookbackMonths}-month lookback window.`
            : `The most recent BMI (${rendered}, ${latest.date.value}) predates the ` +
              `${policy.observationLookbackMonths}-month lookback window starting ${summary.lookbackStart}.`,
        evidence: [bmiEvidence(latest)],
        gap: 'bmi-outside-lookback',
      },
    };
  }

  const value = current.value as number;
  const item = bmiEvidence(current);

  if (value >= policy.bmiSoleThreshold) {
    return {
      reading: current,
      qualifiesAlone: true,
      needsComorbidity: false,
      finding: {
        ...base,
        status: 'met',
        rationale: `BMI ${value} on ${current.date?.value ?? 'an undated record'} is at or above ${policy.bmiSoleThreshold}, which qualifies without a comorbidity.`,
        evidence: [item],
        gap: null,
      },
    };
  }

  if (value >= policy.bmiWithComorbidityThreshold) {
    return {
      reading: current,
      qualifiesAlone: false,
      needsComorbidity: true,
      finding: {
        ...base,
        status: 'met',
        rationale: `BMI ${value} on ${current.date?.value ?? 'an undated record'} is in the ${policy.bmiWithComorbidityThreshold}–${policy.bmiSoleThreshold} band, which qualifies only alongside a comorbidity.`,
        evidence: [item],
        gap: null,
      },
    };
  }

  return {
    ...none,
    finding: {
      ...base,
      status: 'not-met',
      rationale: `BMI ${value} on ${current.date?.value ?? 'an undated record'} is below ${policy.bmiWithComorbidityThreshold}, so neither arm of the policy is satisfied.`,
      evidence: [item],
      gap: null,
    },
  };
}

function evaluateComorbidity(
  evidence: PatientEvidence,
  policy: Policy,
  bmi: BmiOutcome,
): RequirementFinding {
  const accepted = hitsIn(evidence, 'comorbidity');
  const base = {
    id: 'comorbidity' as const,
    label: REQUIREMENT_LABELS['comorbidity'],
    // Evidence is attached whatever the status: a reviewer looking at a
    // not-applicable line still wants to see the conditions that were found.
    evidence: accepted.slice(0, RELATED_EVIDENCE_LIMIT).map((hit) => hitEvidence(hit)),
    ...related(hitsIn(evidence, 'comorbidity-related')),
  };

  if (!bmi.needsComorbidity) {
    const why = bmi.qualifiesAlone
      ? `Not required: BMI is at or above ${policy.bmiSoleThreshold}.`
      : bmi.finding.status === 'not-met'
        ? `Not assessed: BMI is below ${policy.bmiWithComorbidityThreshold}, so the policy fails on BMI regardless of comorbidity.`
        : 'Not assessed: whether a comorbidity is required depends on a BMI this record does not establish.';
    return {
      ...base,
      status: 'not-applicable',
      rationale:
        accepted.length > 0
          ? `${why} ${accepted.length} qualifying condition(s) are recorded and shown for context.`
          : why,
      gap: null,
    };
  }

  if (accepted.length > 0) {
    const names = accepted
      .slice(0, RELATED_EVIDENCE_LIMIT)
      .map((hit) => hit.display ?? hit.matchedCode.display)
      .join(', ');
    return {
      ...base,
      status: 'met',
      rationale: `${accepted.length} qualifying comorbidity/comorbidities recorded: ${names}.`,
      gap: null,
    };
  }

  return {
    ...base,
    status: 'unknown',
    rationale:
      `BMI is in the ${policy.bmiWithComorbidityThreshold}–${policy.bmiSoleThreshold} band, which requires a comorbidity, and no ` +
      `Condition matching the policy's comorbidity code set is recorded. Absence of a coded ` +
      'condition is not proof the patient has none, so this is unresolved rather than failed.',
    gap: 'no-comorbidity-recorded',
  };
}

/** Shared shape of the two documentation requirements. */
function evaluateDocumentation(
  evidence: PatientEvidence,
  id: Extract<RequirementId, 'weight-loss-attempts' | 'psychological-evaluation'>,
  acceptedSet: CodeSetId,
  relatedSet: CodeSetId,
  gap: UnknownReason,
  assessed: boolean,
  notAssessedReason: string,
): RequirementFinding {
  const accepted = hitsIn(evidence, acceptedSet);
  const relatedHits = hitsIn(evidence, relatedSet);
  const base = {
    id,
    label: REQUIREMENT_LABELS[id],
    evidence: accepted.slice(0, RELATED_EVIDENCE_LIMIT).map((hit) => hitEvidence(hit)),
    ...related(relatedHits),
  };

  if (!assessed) {
    return { ...base, status: 'not-applicable', rationale: notAssessedReason, gap: null };
  }

  if (accepted.length > 0) {
    const names = accepted
      .slice(0, RELATED_EVIDENCE_LIMIT)
      .map((hit) => `${hit.display ?? hit.matchedCode.display} (${hit.date?.value ?? 'undated'})`)
      .join(', ');
    return { ...base, status: 'met', rationale: `Documented by ${names}.`, gap: null };
  }

  // The near-miss sentence is the useful half of an unknown: "nothing found" and
  // "eleven depression screens found, none of which is an evaluation" call for
  // very different next actions.
  const rationale =
    relatedHits.length === 0
      ? 'No resource matching the policy\'s accepted code set is recorded, and no related evidence was found either.'
      : `No resource matching the policy's accepted code set is recorded. ${relatedHits.length} related ` +
        `resource(s) were found but do not satisfy the requirement — see the caveat on each.`;

  return { ...base, status: 'unknown', rationale, gap };
}

/**
 * Applies the policy to one patient's evidence.
 *
 * `summary` fixes the review date and the lookback window, and is echoed back on
 * the assessment so a stored result can always be re-derived under exactly the
 * parameters that produced it.
 */
export function evaluateEligibility(
  evidence: PatientEvidence,
  policy: Policy,
  summary: PolicySummary,
): EligibilityAssessment {
  const bmi = evaluateBmi(evidence, policy, summary);
  const comorbidity = evaluateComorbidity(evidence, policy, bmi);

  // The clinical arm as a whole: BMI ≥ 40, or BMI in band with a comorbidity.
  const clinicalFails = bmi.finding.status === 'not-met';
  const clinicalMet =
    bmi.finding.status === 'met' && (bmi.qualifiesAlone || comorbidity.status === 'met');

  // Documentation is skipped only when the patient is already ruled out. When
  // the clinical arm is merely unresolved the documents are still assessed, so a
  // reviewer chasing records gets the complete list of what is missing in one
  // pass rather than one gap at a time.
  const documentationNote =
    `Not assessed: BMI is below ${policy.bmiWithComorbidityThreshold}, so the clinical criteria fail regardless of documentation.`;

  const weightLoss = evaluateDocumentation(
    evidence,
    'weight-loss-attempts',
    'weight-loss',
    'weight-loss-related',
    'no-weight-loss-documentation',
    !clinicalFails,
    documentationNote,
  );
  const psych = evaluateDocumentation(
    evidence,
    'psychological-evaluation',
    'psych-evaluation',
    'psych-evaluation-related',
    'no-psychological-evaluation',
    !clinicalFails,
    documentationNote,
  );

  const requirements = [bmi.finding, comorbidity, weightLoss, psych];

  let determination: Determination;
  let rationale: string;

  if (clinicalFails) {
    determination = 'not-eligible';
    rationale = `Not eligible: ${bmi.finding.rationale}`;
  } else if (
    clinicalMet &&
    weightLoss.status === 'met' &&
    psych.status === 'met'
  ) {
    determination = 'eligible';
    rationale =
      'Eligible: the clinical criteria are met and both documentation requirements are evidenced ' +
      'in the record.';
  } else {
    determination = 'unknown';
    const gaps = requirements.filter((requirement) => requirement.gap !== null);
    rationale =
      `Unknown: ${gaps.length} requirement(s) could not be resolved from the record — ` +
      `${gaps.map((requirement) => requirement.label.toLowerCase()).join(', ')}.`;
  }

  const unknownReasons = requirements
    .filter((requirement) => requirement.gap !== null)
    .map((requirement) => ({
      reason: requirement.gap as UnknownReason,
      label: UNKNOWN_REASON_LABELS[requirement.gap as UnknownReason],
      detail: requirement.rationale,
    }));

  return {
    patientId: evidence.patientId,
    patientRef: `Patient/${evidence.patientId}`,
    policy: summary,
    determination,
    rationale,
    requirements,
    unknownReasons,
  };
}
