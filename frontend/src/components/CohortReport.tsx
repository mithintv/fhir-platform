/**
 * The cohort eligibility report (Part C).
 *
 * Structured to answer the questions in the order a reviewer asks them: how
 * many patients fall in each category, then — because `unknown` is the bucket
 * that implies work — why, and then how far the policy's own code sets actually
 * reach into this export.
 *
 * The two unknown breakdowns are both shown because they answer different
 * questions and neither alone is enough. By reason, the rows overlap and the
 * percentages exceed 100: that ranks how common each gap is. By exact
 * combination, the rows partition the unknown patients: that identifies who is
 * one document away from a determination.
 */
import type { ReactNode } from 'react';
import type { CohortReport as CohortReportData, Determination } from '../lib/api';
import { fetchCohortReport, useAsync } from '../lib/api';
import { formatCount } from '../lib/format';
import { AsyncState, Panel } from './primitives';

const CATEGORY_TONE: Record<Determination, string> = {
  eligible: 'tag tag--type',
  'not-eligible': 'tag tag--alert',
  unknown: 'tag tag--gap',
};

const CATEGORY_LABEL: Record<Determination, string> = {
  eligible: 'Eligible',
  'not-eligible': 'Not eligible',
  unknown: 'Unknown',
};

/** A count with its share, as one tile. */
function CategoryTile({
  determination,
  count,
  percent,
}: {
  determination: Determination;
  count: number;
  percent: number;
}): ReactNode {
  return (
    <div className="metric">
      <div className="metric__label">
        <span className={CATEGORY_TONE[determination]}>{CATEGORY_LABEL[determination]}</span>
      </div>
      <div className="metric__value">{formatCount(count)}</div>
      <div className="metric__meta">{percent.toFixed(1)}% of cohort</div>
    </div>
  );
}

function Report({ report }: { report: CohortReportData }): ReactNode {
  const { policy, context } = report;
  const eligible = report.categories.find((entry) => entry.determination === 'eligible');
  const documentationReach = report.codeCoverage.filter(
    (entry) => entry.setId === 'weight-loss' || entry.setId === 'psych-evaluation',
  );

  return (
    <>
      <Panel
        title="Cohort eligibility"
        note={`${formatCount(report.totalPatients)} patients · ${policy.label} v${policy.version}`}
        flush
      >
        <div className="panel__body">
          <p className="hint">
            Assessed as of <strong>{policy.asOf}</strong>
            {policy.asOfSource === 'store-latest-clinical-date' ? (
              <span
                className="tag tag--gap"
                style={{ marginLeft: 6 }}
                title="The newest clinical date in this export. Scored against today, every BMI in the file would be stale — a fact about the export's age, not about any patient."
              >
                anchored to the data, not today
              </span>
            ) : null}
            {' · '}BMI lookback from <strong>{policy.lookbackStart}</strong>
            {' · '}computed in {report.computeMs.toFixed(0)} ms
          </p>
        </div>

        <div className="metrics">
          {report.categories.map((category) => (
            <CategoryTile key={category.determination} {...category} />
          ))}
        </div>

        {/*
          A zero-eligible cohort is a startling number to publish without an
          explanation, and the explanation is a property of the export rather
          than of the patients: nothing in it satisfies both documentation
          requirements. Saying so here is the difference between a report that
          reads as "these patients were denied" and one that reads as "this data
          cannot answer the question".
        */}
        {eligible?.count === 0 ? (
          <div className="panel__body">
            <div className="banner banner--gap" style={{ marginBottom: 0 }}>
              <strong>No patient reaches "eligible" in this export.</strong> The policy needs both
              documented weight-loss attempts and a psychological evaluation.{' '}
              {formatCount(context.patientsWithWeightLossDocumentation)} patient
              {context.patientsWithWeightLossDocumentation === 1 ? ' has' : 's have'} the first,{' '}
              {formatCount(context.patientsWithPsychEvaluation)} the second, and{' '}
              {formatCount(context.patientsWithBothDocuments)} both — so the eligible set is empty
              before BMI is considered. That is a gap in what this synthetic export models, not a
              clinical finding about these patients.
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Why patients are unknown"
        note="a patient can carry several reasons, so these rows overlap"
        flush
      >
        {report.unknownReasons.length === 0 ? (
          <div className="empty">No patient is unknown.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th>Patients</th>
                  <th>Of unknown</th>
                  <th>Of cohort</th>
                </tr>
              </thead>
              <tbody>
                {report.unknownReasons.map((reason) => (
                  <tr key={reason.reason}>
                    <td className="table__name">
                      {reason.label}
                      <div className="table__ref">{reason.reason}</div>
                    </td>
                    <td className="table__value">{formatCount(reason.patients)}</td>
                    <td className="table__date">{reason.percentOfUnknown.toFixed(1)}%</td>
                    <td className="table__date">{reason.percentOfCohort.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Unknown patients by their exact set of gaps"
        note="mutually exclusive — a one-gap row is a single document from a determination"
        flush
      >
        {report.unknownCombinations.length === 0 ? (
          <div className="empty">No patient is unknown.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Outstanding</th>
                  <th>Gaps</th>
                  <th>Patients</th>
                  <th>Of unknown</th>
                </tr>
              </thead>
              <tbody>
                {report.unknownCombinations.map((combination) => (
                  <tr key={combination.reasons.join('+')}>
                    <td className="table__name">
                      <div className="stack">
                        {combination.reasons.map((reason) => (
                          <span className="tag tag--gap" key={reason}>
                            {reason}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="table__value">{combination.reasons.length}</td>
                    <td className="table__value">{formatCount(combination.patients)}</td>
                    <td className="table__date">{combination.percentOfUnknown.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="How far each arm of the policy reaches" flush>
        <div className="scroll-x">
          <table className="table">
            <tbody>
              {[
                ['Patients with any BMI observation', context.patientsWithAnyBmi],
                ['… with one inside the lookback window', context.patientsWithBmiInWindow],
                [`… meeting BMI ≥ ${policy.bmiSoleThreshold} on its own`, context.patientsMeetingBmiSoleThreshold],
                [
                  `… in the ${policy.bmiWithComorbidityThreshold}–${policy.bmiSoleThreshold} band with a coded comorbidity`,
                  context.patientsMeetingBmiWithComorbidity,
                ],
                [
                  `… in the ${policy.bmiWithComorbidityThreshold}–${policy.bmiSoleThreshold} band with none coded`,
                  context.patientsInBmiBandWithoutComorbidity,
                ],
                ['Patients with documented weight-loss attempts', context.patientsWithWeightLossDocumentation],
                ['Patients with a psychological evaluation', context.patientsWithPsychEvaluation],
                ['Patients with both documentation requirements', context.patientsWithBothDocuments],
                ['Deceased patients in the cohort', context.deceasedPatients],
              ].map(([label, value]) => (
                <tr key={label as string}>
                  <td className="table__name">{label}</td>
                  <td className="table__value">{formatCount(value as number)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Policy code coverage"
        note={`accepted documentation codes · ${report.unmatchedPolicyCodes.length} policy code(s) match nothing in this store`}
        flush
      >
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Set</th>
                <th>Code</th>
                <th>Display</th>
                <th>Patients</th>
                <th>Resources</th>
              </tr>
            </thead>
            <tbody>
              {documentationReach.map((entry) => (
                <tr key={`${entry.system}|${entry.code}`}>
                  <td>
                    <span className="tag">{entry.setId}</span>
                  </td>
                  <td className="table__ref">{entry.code}</td>
                  <td className="table__name">{entry.display}</td>
                  <td className="table__value">{formatCount(entry.patients)}</td>
                  <td className="table__value">{formatCount(entry.resources)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.danglingSubjectPatients > 0 ? (
          <div className="panel__body">
            <p className="hint">
              {formatCount(report.danglingSubjectPatients)} further subject ids are referenced by
              resources in this export but have no Patient resource, so they are outside the cohort.
            </p>
          </div>
        ) : null}
      </Panel>
    </>
  );
}

export function CohortReport(): ReactNode {
  const report = useAsync((signal) => fetchCohortReport(undefined, signal), []);

  return (
    <AsyncState loading={report.loading && !report.data} error={report.error}>
      {report.data ? <Report report={report.data} /> : null}
    </AsyncState>
  );
}
