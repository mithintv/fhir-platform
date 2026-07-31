/**
 * The clinical snapshot.
 *
 * Reading order is the clinical one: who the patient is, then the numbers a
 * coverage decision turns on, then the conditions, then what was done. Each
 * section states its own completeness — counts of what is shown against what
 * exists, and a named gap wherever the record is silent.
 */
import type { ReactNode } from 'react';
import type { Age, ClinicalSnapshot, ConditionEntry, KeyObservation } from '../lib/api';
import { formatCount, humanizeCode } from '../lib/format';
import { Fact, FhirDate, Missing, Panel } from './primitives';

/** Why an age could not be computed, in the reviewer's language. */
const AGE_GAP_REASONS: Record<Extract<Age, { kind: 'unknown' }>['reason'], string> = {
  'no-birth-date': 'The Patient resource has no birthDate element.',
  'died-before-birth-date':
    'The recorded date of death precedes the recorded birth date — the source data contradicts itself.',
  'birth-date-in-future': 'The recorded birth date is in the future — the source data is invalid.',
};

function AgeValue({ age }: { age: Age }): ReactNode {
  switch (age.kind) {
    case 'living':
      return (
        <>
          {age.years} <span className="hint">yrs</span>
        </>
      );
    case 'at-death':
      return (
        <>
          {age.years} <span className="hint">yrs at death</span>
        </>
      );
    case 'unknown':
      return <Missing label="Unknown" reason={AGE_GAP_REASONS[age.reason]} />;
  }
}

/** One tile in the key-observation panel. Absent metrics keep their tile. */
function MetricTile({ observation }: { observation: KeyObservation }): ReactNode {
  if (observation.kind === 'absent') {
    return (
      <div className="metric metric--absent">
        <div className="metric__label">{observation.label}</div>
        <div className="metric__value">
          <Missing label="Not recorded" reason={observation.note} />
        </div>
        <div className="metric__meta">LOINC {observation.codes.join(', ')}</div>
      </div>
    );
  }

  const { latest, count, earliest } = observation;

  return (
    <div className="metric">
      <div className="metric__label">{observation.label}</div>
      <div className="metric__value">
        {latest.value ?? (
          <Missing
            label="No value"
            reason={
              latest.dataAbsentReason
                ? `The Observation exists but records no value. FHIR dataAbsentReason: ${latest.dataAbsentReason}.`
                : 'The Observation exists but carries no value element this view can render.'
            }
          />
        )}
      </div>
      <div className="metric__meta">
        <FhirDate date={latest.date} />
      </div>
      {latest.parts.length > 0 ? (
        <div className="metric__parts">
          {latest.parts.map((part) => (
            <span key={part.label} title={part.label}>
              {part.label.replace(/ Blood Pressure$/i, '')}: {part.value}
            </span>
          ))}
        </div>
      ) : null}
      <div className="metric__meta">
        {count === 1
          ? '1 reading'
          : `${formatCount(count)} readings, since ${earliest ? (earliest.value.slice(0, 4) ?? '') : '—'}`}
      </div>
      <div className="metric__meta">
        <span className="table__ref">{latest.ref}</span>
      </div>
    </div>
  );
}

function ConditionRows({ conditions }: { conditions: ConditionEntry[] }): ReactNode {
  return (
    <>
      {conditions.map((condition) => (
        <tr key={condition.ref}>
          <td className="table__name">
            {condition.display ?? (
              <Missing
                label="No code"
                reason="This Condition carries no code element, so it has no display name."
              />
            )}
          </td>
          <td>
            {condition.clinicalStatus ? (
              <span className="tag">{humanizeCode(condition.clinicalStatus)}</span>
            ) : (
              <Missing
                label="Not stated"
                reason="This Condition has no clinicalStatus, so it is neither active nor resolved on the record."
              />
            )}
          </td>
          <td>
            {condition.verificationStatus ? (
              <span className="tag">{humanizeCode(condition.verificationStatus)}</span>
            ) : (
              <Missing
                label="Not stated"
                reason="This Condition has no verificationStatus — it is not recorded as confirmed or provisional."
              />
            )}
          </td>
          <td className="table__date">
            <FhirDate
              date={condition.onset}
              reason="This Condition records no onset date."
            />
          </td>
          <td className="table__ref">{condition.ref}</td>
        </tr>
      ))}
    </>
  );
}

export function Snapshot({ snapshot }: { snapshot: ClinicalSnapshot }): ReactNode {
  const { patient, age } = snapshot;
  const undatedTotal = snapshot.resourceMix.reduce((sum, entry) => sum + entry.undated, 0);

  return (
    <>
      <section className="panel">
        <div className="patient-head">
          <h1 className="patient-head__name">
            {patient.name ?? (
              <Missing
                label="Unnamed patient"
                reason="The Patient resource carried no usable name element."
              />
            )}
          </h1>
          <span className="patient-head__ref">{patient.ref}</span>
          {patient.deceased ? <span className="tag tag--alert">Deceased</span> : null}
        </div>

        <div className="facts">
          <Fact label="Age">
            <AgeValue age={age} />
          </Fact>
          <Fact label="Sex">
            {patient.gender ?? (
              <Missing
                reason="The Patient resource has no administrative gender element."
              />
            )}
          </Fact>
          <Fact label="Birth sex">
            {patient.birthSex ?? (
              <Missing reason="No US Core birth-sex extension on the Patient resource." />
            )}
          </Fact>
          <Fact label="Date of birth">
            <FhirDate
              date={patient.birthDate}
              reason="The Patient resource has no birthDate element."
            />
          </Fact>
          {patient.deceased ? (
            <Fact label="Died">
              <FhirDate
                date={patient.deceasedDate}
                reason="Recorded as deceased, but with no date of death."
              />
            </Fact>
          ) : null}
          <Fact label="Race">
            {patient.race ?? <Missing reason="No US Core race extension recorded." />}
          </Fact>
          <Fact label="Ethnicity">
            {patient.ethnicity ?? <Missing reason="No US Core ethnicity extension recorded." />}
          </Fact>
          <Fact label="Location">
            {patient.address?.city || patient.address?.state ? (
              [patient.address.city, patient.address.state].filter(Boolean).join(', ')
            ) : (
              <Missing reason="The Patient resource records no address city or state." />
            )}
          </Fact>
        </div>

        {patient.issues.length > 0 ? (
          <div className="panel__body">
            <div className="banner banner--gap" style={{ marginBottom: 0 }}>
              Ingest flagged this Patient record: {patient.issues.join(', ')}
            </div>
          </div>
        ) : null}
      </section>

      <Panel
        title="Key observations"
        note="Latest reading per metric, matched on LOINC code"
        flush
      >
        <div className="metrics">
          {snapshot.keyObservations.map((observation) => (
            <MetricTile key={observation.metric} observation={observation} />
          ))}
        </div>
      </Panel>

      <Panel
        title="Active conditions"
        note={
          <>
            {formatCount(snapshot.activeConditions.length)} active
            {snapshot.inactiveConditionCount > 0
              ? ` · ${formatCount(snapshot.inactiveConditionCount)} resolved or in remission, not shown`
              : ''}
          </>
        }
        flush
      >
        {snapshot.activeConditions.length === 0 && snapshot.undeterminedConditions.length === 0 ? (
          <div className="empty">No Condition resources for this patient.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Clinical status</th>
                  <th>Verification</th>
                  <th>Onset</th>
                  <th>Source ID</th>
                </tr>
              </thead>
              <tbody>
                <ConditionRows conditions={snapshot.activeConditions} />
                {snapshot.undeterminedConditions.length > 0 ? (
                  <>
                    <tr>
                      <td colSpan={5} style={{ background: 'var(--gap-soft)', color: 'var(--gap-ink)' }}>
                        {formatCount(snapshot.undeterminedConditions.length)} condition
                        {snapshot.undeterminedConditions.length === 1 ? '' : 's'} with no
                        clinicalStatus — neither active nor resolved on the record, so they are
                        listed rather than assumed either way.
                      </td>
                    </tr>
                    <ConditionRows conditions={snapshot.undeterminedConditions} />
                  </>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Recent procedures"
        note={`${formatCount(snapshot.recentProcedures.length)} most recent of ${formatCount(snapshot.procedureCount)}`}
        flush
      >
        {snapshot.recentProcedures.length === 0 ? (
          <div className="empty">No Procedure resources for this patient.</div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead>
                <tr>
                  <th>Procedure</th>
                  <th>Status</th>
                  <th>Performed</th>
                  <th>Source ID</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recentProcedures.map((procedure) => (
                  <tr key={procedure.ref}>
                    <td className="table__name">
                      {procedure.display ?? (
                        <Missing
                          label="No code"
                          reason="This Procedure carries no code element."
                        />
                      )}
                    </td>
                    <td>
                      {procedure.status ? (
                        <span className="tag">{humanizeCode(procedure.status)}</span>
                      ) : (
                        <Missing label="Not stated" reason="This Procedure has no status element." />
                      )}
                    </td>
                    <td className="table__date">
                      <FhirDate
                        date={procedure.performed}
                        reason="This Procedure records no performed date or period."
                      />
                    </td>
                    <td className="table__ref">{procedure.ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Record contents"
        note={
          undatedTotal > 0
            ? `${formatCount(undatedTotal)} resources carry no usable date`
            : 'every resource carries a date'
        }
      >
        <div className="stack">
          {snapshot.resourceMix.map((entry) => (
            <span
              key={entry.resourceType}
              className={entry.undated > 0 ? 'tag tag--gap' : 'tag'}
              title={
                entry.undated > 0
                  ? `${formatCount(entry.undated)} of ${formatCount(entry.count)} ${entry.resourceType} resources have no usable date and cannot be placed on the timeline.`
                  : `${formatCount(entry.count)} ${entry.resourceType} resources.`
              }
            >
              {entry.resourceType} {formatCount(entry.count)}
              {entry.undated > 0 ? ` (${formatCount(entry.undated)} undated)` : ''}
            </span>
          ))}
        </div>
      </Panel>
    </>
  );
}
