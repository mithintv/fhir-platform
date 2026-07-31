/**
 * What the model is allowed to see, and what it is allowed to cite.
 *
 * This module turns a Part C `EligibilityAssessment` into two things:
 *
 *  1. A **briefing** — the facts, already decided, that the model writes prose
 *     about. It is a projection of the assessment, not a second read of the
 *     store: if a resource is not already cited by the deterministic checklist,
 *     the model never learns it exists.
 *  2. A **citable set** — every ref the briefing mentions, tagged with the tier
 *     Part C put it in, plus the numbers those resources actually carry.
 *
 * The citable set is the thing that makes grounding checkable. "Every factual
 * claim must reference one or more FHIR resource ids" is only enforceable if
 * there is a closed list of ids a claim is permitted to reference, and the list
 * has to be derived from the assessment rather than from the store — otherwise
 * a model could cite a real resource belonging to the patient that had nothing
 * to do with the decision, and the citation would resolve while the claim
 * remained unsupported.
 *
 * ## Tiers travel with the refs
 *
 * Part C already draws the line this section needs: `evidence` satisfied a
 * requirement, `relatedEvidence` is clinically adjacent and explicitly did not.
 * That distinction is what lets `validate.ts` catch a model writing up a PHQ-9
 * as a psychological evaluation without needing any clinical knowledge of its
 * own — it only has to notice that a `related` ref was cited by a claim that
 * did not flag itself as a gap.
 */
import type {
  EligibilityAssessment,
  EvidenceItem,
  RequirementFinding,
  UnknownReason,
} from '../eligibility/dto.js';
import type { Age, PatientDemographics } from '../query/dto.js';

/** Which of Part C's two evidence tiers a citable ref came from. */
export type CitationTier = 'accepted' | 'related' | 'patient';

/** One resource the model may cite, with everything it may say about it. */
export interface CitableResource {
  ref: string;
  tier: CitationTier;
  display: string | null;
  /** The FHIR date string, at recorded precision. */
  date: string | null;
  /** Rendered value, e.g. `41.7 kg/m2`. */
  value: string | null;
  /** Why this resource does not satisfy the requirement, on `related` refs. */
  caveat: string | null;
  /** The requirement this resource was attached to. */
  requirementId: string;
}

/** The demographic facts, all attributable to the Patient resource. */
export interface AssistDemographics {
  ref: string;
  /** Rendered age, or an explicit statement that there is none. */
  age: string;
  /** The same age as a sentence opener: `52-year-old`. */
  agePhrase: string;
  /** Numeric age, when there is one — kept so it can ground a number in prose. */
  ageYears: number | null;
  gender: string | null;
  birthSex: string | null;
  deceased: boolean;
}

/** A requirement, as the model sees it: decided, with its working attached. */
export interface BriefedRequirement {
  requirementId: string;
  label: string;
  status: string;
  rationale: string;
  /** Which gap leaves this requirement unresolved, when one does. */
  gap: UnknownReason | null;
  evidence: CitableResource[];
  relatedEvidence: CitableResource[];
  /** How many related resources exist beyond the ones listed. */
  relatedEvidenceOmitted: number;
}

/**
 * Evidence that points two ways at once.
 *
 * Surfaced as its own block rather than left implicit in `relatedEvidence`,
 * because "handle conflicting evidence" is an explicit requirement of the
 * brief and the honest handling is to state the conflict, not to resolve it.
 * The canonical case in this dataset is RxNorm 897122 — the same product code
 * is Victoza for type 2 diabetes and Saxenda for weight management — which is
 * genuinely ambiguous rather than merely weak.
 */
export interface EvidenceConflict {
  ref: string;
  display: string | null;
  requirementId: string;
  caveat: string;
}

export interface AssistContext {
  patientId: string;
  patientRef: string;
  demographics: AssistDemographics;
  determination: string;
  determinationRationale: string;
  requirements: BriefedRequirement[];
  conflicts: EvidenceConflict[];
  /** Every gap standing between this patient and a determination. */
  openGaps: { requirementId: string; reason: UnknownReason; label: string; detail: string }[];
  policy: {
    label: string;
    version: string;
    asOf: string;
    lookbackStart: string;
    bmiSoleThreshold: number;
    bmiWithComorbidityThreshold: number;
    observationLookbackMonths: number;
  };
  /** ref -> the resource, for the grounding check. */
  citable: Map<string, CitableResource>;
  /**
   * Numbers any claim may use without citing a resource for them.
   *
   * The policy's own thresholds and the patient's age are facts about the
   * review rather than about a particular resource, so requiring a citation for
   * "40" in "BMI is at or above 40" would reject a correct sentence.
   */
  ambientNumbers: Set<string>;
}

/** Normalizes a numeric token so `41.70` and `41.7` compare equal. */
export function normalizeNumber(token: string): string {
  const value = Number(token);
  return Number.isFinite(value) ? String(value) : token;
}

/** Every number appearing in a string, normalized. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(normalizeNumber);
}

/** Renders `Age` as something a sentence can contain. */
function renderAge(age: Age): { text: string; phrase: string; years: number | null } {
  switch (age.kind) {
    case 'living':
      return { text: `${age.years} years old`, phrase: `${age.years}-year-old`, years: age.years };
    case 'at-death':
      return {
        text: `${age.years} at death (died ${age.diedOn})`,
        phrase: `${age.years}-year-old, deceased`,
        years: age.years,
      };
    case 'unknown':
      return { text: `age unknown (${age.reason})`, phrase: 'patient of unrecorded age', years: null };
  }
}

function toCitable(
  item: EvidenceItem,
  tier: CitationTier,
  requirementId: string,
): CitableResource {
  return {
    ref: item.ref,
    tier,
    display: item.display ?? item.matchedCode.display,
    date: item.date?.value ?? null,
    value: item.value,
    caveat: item.caveat ?? null,
    requirementId,
  };
}

function briefRequirement(finding: RequirementFinding): BriefedRequirement {
  return {
    requirementId: finding.id,
    label: finding.label,
    status: finding.status,
    rationale: finding.rationale,
    gap: finding.gap,
    evidence: finding.evidence.map((item) => toCitable(item, 'accepted', finding.id)),
    relatedEvidence: finding.relatedEvidence.map((item) => toCitable(item, 'related', finding.id)),
    relatedEvidenceOmitted: Math.max(
      0,
      finding.relatedEvidenceTotal - finding.relatedEvidence.length,
    ),
  };
}

/**
 * Builds the briefing and the citable set for one patient.
 *
 * `demographics` and `age` come from the snapshot the UI already renders, so
 * the age in an assist summary is the same age shown on the patient header
 * rather than a second, subtly different computation.
 */
export function buildAssistContext(
  assessment: EligibilityAssessment,
  patient: PatientDemographics,
  age: Age,
): AssistContext {
  const requirements = assessment.requirements.map(briefRequirement);

  const citable = new Map<string, CitableResource>();
  for (const requirement of requirements) {
    for (const item of [...requirement.evidence, ...requirement.relatedEvidence]) {
      // First writer wins: a resource cited by two requirements keeps the tier
      // it was accepted under, so an accepted ref is never demoted to related
      // by a later appearance in someone else's near-miss list.
      const existing = citable.get(item.ref);
      if (existing === undefined || (existing.tier === 'related' && item.tier === 'accepted')) {
        citable.set(item.ref, item);
      }
    }
  }

  const rendered = renderAge(age);
  const demographics: AssistDemographics = {
    ref: patient.ref,
    age: rendered.text,
    agePhrase: rendered.phrase,
    ageYears: rendered.years,
    gender: patient.gender,
    birthSex: patient.birthSex,
    deceased: patient.deceased,
  };

  // The Patient resource is citable so that demographic claims — the "52-year-old
  // female" half of the brief's example summary — have something to point at.
  citable.set(patient.ref, {
    ref: patient.ref,
    tier: 'patient',
    display: patient.name,
    date: patient.birthDate?.value ?? null,
    value: null,
    caveat: null,
    requirementId: 'demographics',
  });

  const conflicts: EvidenceConflict[] = [];
  for (const requirement of requirements) {
    for (const item of requirement.relatedEvidence) {
      if (item.caveat === null) continue;
      conflicts.push({
        ref: item.ref,
        display: item.display,
        requirementId: requirement.requirementId,
        caveat: item.caveat,
      });
    }
  }

  const ambientNumbers = new Set<string>([
    ...numbersIn(String(assessment.policy.bmiSoleThreshold)),
    ...numbersIn(String(assessment.policy.bmiWithComorbidityThreshold)),
    ...numbersIn(String(assessment.policy.observationLookbackMonths)),
    ...numbersIn(assessment.policy.asOf),
    ...numbersIn(assessment.policy.lookbackStart),
  ]);
  if (rendered.years !== null) ambientNumbers.add(normalizeNumber(String(rendered.years)));
  if (patient.birthDate) for (const n of numbersIn(patient.birthDate.value)) ambientNumbers.add(n);

  return {
    patientId: assessment.patientId,
    patientRef: assessment.patientRef,
    demographics,
    determination: assessment.determination,
    determinationRationale: assessment.rationale,
    requirements,
    conflicts,
    openGaps: assessment.unknownReasons.map((entry) => {
      const owner = assessment.requirements.find((requirement) => requirement.gap === entry.reason);
      return {
        requirementId: owner?.id ?? entry.reason,
        reason: entry.reason,
        label: entry.label,
        detail: entry.detail,
      };
    }),
    policy: {
      label: assessment.policy.label,
      version: assessment.policy.version,
      asOf: assessment.policy.asOf,
      lookbackStart: assessment.policy.lookbackStart,
      bmiSoleThreshold: assessment.policy.bmiSoleThreshold,
      bmiWithComorbidityThreshold: assessment.policy.bmiWithComorbidityThreshold,
      observationLookbackMonths: assessment.policy.observationLookbackMonths,
    },
    citable,
    ambientNumbers,
  };
}

/** Every number a resource carries, for the number-traceability check. */
export function numbersFor(resource: CitableResource): Set<string> {
  const numbers = new Set<string>();
  // `ref` is in the list because a claim that names its own citation inline —
  // "the BMI on Observation/obs-3" — would otherwise fail number traceability
  // on the id itself.
  for (const field of [resource.value, resource.date, resource.display, resource.ref]) {
    if (field === null) continue;
    for (const token of numbersIn(field)) numbers.add(token);
  }
  return numbers;
}
