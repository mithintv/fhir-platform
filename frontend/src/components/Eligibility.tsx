/**
 * The per-patient eligibility review (Part C).
 *
 * Split across two surfaces. The **verdict bar** stays on the patient page: the
 * determination and the one sentence that produced it are what a reviewer needs
 * at a glance, and burying those behind a click would make the tool's whole
 * answer invisible until asked for. The **drawer** holds the working — every
 * requirement with its status, its reasoning, and the FHIR resource ids it was
 * decided from, which is a reading task that wants the full height of the
 * window rather than a slot between the snapshot and the timeline.
 *
 * Citations use the same `ResourceType/id` format as the timeline, so any line
 * here can be cross-checked against the source record.
 *
 * `unknown` gets the most affordance, not the least. It is the common outcome
 * in this dataset and the only one that implies work, so its gaps are listed as
 * an explicit "what would resolve this" block rather than being left implicit
 * in the checklist.
 */
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import type {
  Determination,
  EligibilityAssessment,
  EvidenceItem,
  RequirementFinding,
  RequirementStatus,
} from '../lib/api';
import { Drawer, FhirDate, Missing } from './primitives';

/** How each verdict is worded and coloured. */
const DETERMINATION_STYLE: Record<
  Determination,
  { label: string; tone: 'ok' | 'gap' | 'alert'; blurb: string }
> = {
  eligible: {
    label: 'Eligible',
    tone: 'ok',
    blurb: 'Every requirement is evidenced in the record.',
  },
  'not-eligible': {
    label: 'Not eligible',
    tone: 'alert',
    blurb: 'The record positively establishes that the clinical criteria are not met.',
  },
  unknown: {
    label: 'Unknown',
    tone: 'gap',
    blurb: 'The record is insufficient to decide. This is not a denial.',
  },
};

const STATUS_STYLE: Record<RequirementStatus, { label: string; className: string }> = {
  met: { label: 'Met', className: 'tag tag--type' },
  'not-met': { label: 'Not met', className: 'tag tag--alert' },
  unknown: { label: 'Unknown', className: 'tag tag--gap' },
  'not-applicable': { label: 'Not required', className: 'tag' },
};

/** One cited resource: what it is, when, and its id. */
function Evidence({ item, weak }: { item: EvidenceItem; weak?: boolean }): ReactNode {
  return (
    <li className={weak ? 'evidence evidence--weak' : 'evidence'}>
      <span className="evidence__name">
        {item.display ?? (
          <Missing label="No code" reason="This resource carries no code element." />
        )}
        {item.value ? <strong> — {item.value}</strong> : null}
      </span>
      <span className="evidence__meta">
        <FhirDate date={item.date} reason="This resource carries no usable date." />
        {' · '}
        <span className="table__ref" title={`${item.matchedCode.system}|${item.matchedCode.code}`}>
          {item.ref}
        </span>
      </span>
      {/*
        The caveat is the whole point of showing weak evidence. Without it a
        PHQ-9 sitting under "Psychological evaluation: unknown" looks like a
        rendering bug rather than a deliberate "found, and not sufficient".
      */}
      {item.caveat ? <span className="evidence__caveat">{item.caveat}</span> : null}
    </li>
  );
}

function Requirement({ finding }: { finding: RequirementFinding }): ReactNode {
  const style = STATUS_STYLE[finding.status];
  const hiddenRelated = finding.relatedEvidenceTotal - finding.relatedEvidence.length;

  return (
    <div className={finding.status === 'unknown' ? 'checkline checkline--gap' : 'checkline'}>
      <div className="checkline__head">
        <span className={style.className}>{style.label}</span>
        <span className="checkline__label">{finding.label}</span>
      </div>
      <p className="checkline__why">{finding.rationale}</p>

      {finding.evidence.length > 0 ? (
        <ul className="evidence-list">
          {finding.evidence.map((item) => (
            <Evidence key={item.ref} item={item} />
          ))}
        </ul>
      ) : null}

      {finding.relatedEvidence.length > 0 ? (
        <>
          <div className="checkline__subhead">
            Related, but not sufficient
            {hiddenRelated > 0 ? ` — showing ${finding.relatedEvidence.length} of ${finding.relatedEvidenceTotal}` : ''}
          </div>
          <ul className="evidence-list">
            {finding.relatedEvidence.map((item) => (
              <Evidence key={item.ref} item={item} weak />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** The policy parameters the assessment was produced under. */
function PolicyLine({ policy }: { policy: EligibilityAssessment['policy'] }): ReactNode {
  return (
    <p className="hint">
      Assessed as of <strong>{policy.asOf}</strong>
      {policy.asOfSource === 'store-latest-clinical-date' ? (
        <span
          className="tag tag--gap"
          style={{ marginLeft: 6 }}
          title="This export is a historical snapshot. Scoring it against today's date would mark every reading stale for reasons about the file, not the patient. Anchoring to the newest clinical date in the store asks whether the BMI was current while the record was being kept."
        >
          anchored to the data, not today
        </span>
      ) : null}
      {' · '}BMI must fall on or after <strong>{policy.lookbackStart}</strong> (
      {policy.observationLookbackMonths} months)
      {' · '}BMI ≥ {policy.bmiSoleThreshold} alone, or ≥ {policy.bmiWithComorbidityThreshold} with a
      comorbidity
    </p>
  );
}

/** The full working: policy parameters, the checklist, and the outstanding gaps. */
function AssessmentDetail({ assessment }: { assessment: EligibilityAssessment }): ReactNode {
  const verdict = DETERMINATION_STYLE[assessment.determination];

  return (
    <>
      <div className={`verdict verdict--${verdict.tone}`}>
        <div className="verdict__word">{verdict.label}</div>
        <div className="verdict__detail">
          <p className="verdict__rationale">{assessment.rationale}</p>
          <p className="hint">{verdict.blurb}</p>
        </div>
      </div>

      {/*
        The review date is surfaced rather than assumed. It is not today's date
        by default — it is the newest clinical date in the export — and a
        lookback window scored against an unstated date is not reviewable.
      */}
      <div className="drawer__section">
        <PolicyLine policy={assessment.policy} />
      </div>

      <div className="checklist">
        {assessment.requirements.map((finding) => (
          <Requirement key={finding.id} finding={finding} />
        ))}
      </div>

      {assessment.unknownReasons.length > 0 ? (
        <div className="drawer__section">
          <div className="banner banner--gap" style={{ marginBottom: 0 }}>
            <strong>
              What would resolve this: {assessment.unknownReasons.length} outstanding item
              {assessment.unknownReasons.length === 1 ? '' : 's'}
            </strong>
            <ul className="reason-list">
              {assessment.unknownReasons.map((reason) => (
                <li key={reason.reason}>
                  <strong>{reason.label}.</strong> {reason.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="drawer__section">
        <p className="hint">
          This determination is produced by deterministic policy logic over the FHIR record.
          Every line above cites the resources it was decided from, and nothing here is inferred
          from an uncited claim.
        </p>
      </div>
    </>
  );
}

/**
 * The verdict bar on the patient page, and the drawer it opens.
 *
 * The bar carries the answer; the drawer carries the argument. The gap count on
 * the bar is what makes the drawer worth opening — "Unknown" alone gives a
 * reviewer nothing to act on, "Unknown · 2 outstanding" tells them how much work
 * is behind it before they commit to reading.
 */
export function Eligibility({ assessment }: { assessment: EligibilityAssessment }): ReactNode {
  const [open, setOpen] = useState(false);
  // Stable identity so the drawer's Escape/focus effect does not tear down and
  // re-run on every render of this component.
  const close = useCallback(() => setOpen(false), []);

  const verdict = DETERMINATION_STYLE[assessment.determination];
  const gaps = assessment.unknownReasons.length;

  return (
    <>
      <section className={`verdict-bar verdict--${verdict.tone}`}>
        <div className="verdict-bar__main">
          <div className="verdict-bar__label">Bariatric surgery eligibility</div>
          <div className="verdict-bar__word">
            {verdict.label}
            {gaps > 0 ? (
              <span className="verdict-bar__gaps">
                {gaps} outstanding item{gaps === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <p className="verdict__rationale">{assessment.rationale}</p>
        </div>
        <button
          type="button"
          className="button button--on"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          Review checklist
        </button>
      </section>

      <Drawer
        open={open}
        title="Bariatric surgery eligibility"
        note={`${assessment.policy.label} · v${assessment.policy.version}`}
        onClose={close}
      >
        <AssessmentDetail assessment={assessment} />
      </Drawer>
    </>
  );
}
