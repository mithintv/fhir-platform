/**
 * Application shell.
 *
 * The selected patient id is the single piece of shared state, held here and
 * passed down. "Switching patients updates all views" is then structural rather
 * than something each view has to remember to do: the snapshot and the timeline
 * both key off the same value, and `useAsync` aborts the in-flight request for
 * the previous patient so a slow response cannot land after a fast one.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { fetchEligibility, fetchSnapshot, fetchStoreMeta, useAsync } from './lib/api';
import { formatCount } from './lib/format';
import { PatientSelector } from './components/PatientSelector';
import { Snapshot } from './components/Snapshot';
import { Timeline } from './components/Timeline';
import { Eligibility } from './components/Eligibility';
import { CohortReport } from './components/CohortReport';
import { SnapshotSkeleton } from './components/primitives';

function StoreBadge(): ReactNode {
  const meta = useAsync((signal) => fetchStoreMeta(signal), []);
  if (!meta.data) return null;

  const failed = meta.data.verification.filter((check) => !check.ok);
  const checks = meta.data.verification.length;

  return (
    <div className="masthead__meta">
      <span>{formatCount(meta.data.patients)} patients</span>
      <span>{formatCount(meta.data.resources)} resources</span>
      {meta.data.ingestedAt ? <span>ingested {meta.data.ingestedAt.slice(0, 10)}</span> : null}
      {/*
        Three distinct states, never collapsed: checks passed, checks failed, or
        no checks were recorded at all. The last is not a pass — an ingest run
        with --no-verify leaves no evidence either way, and the UI says so.
      */}
      {checks === 0 ? (
        <span className="tag tag--gap" title="This store was written without the independent integrity checks. Re-run the ingest without --no-verify to record them.">
          integrity unverified
        </span>
      ) : failed.length > 0 ? (
        <span className="tag tag--alert" title={failed.map((check) => check.name).join(', ')}>
          {failed.length} integrity check{failed.length === 1 ? '' : 's'} FAILED
        </span>
      ) : (
        <span className="tag" title={meta.data.verification.map((check) => check.name).join(', ')}>
          {checks} integrity checks passed
        </span>
      )}
    </div>
  );
}

/**
 * One patient's snapshot and timeline.
 *
 * Mounted with `key={patientId}` by the shell, so switching patients discards
 * this component's state rather than reusing it. That is what makes the loading
 * state correct: `useAsync` deliberately keeps the previous result while a new
 * request is in flight — right for paging within one patient, badly wrong
 * across patients, where it would leave the *previous* patient's snapshot on
 * screen for the duration of the fetch, indistinguishable from the current one.
 * Remounting means there is no previous result to show.
 */
/**
 * The eligibility panel, fetched independently of the snapshot.
 *
 * Separate request on purpose: the assessment reads different tables and can be
 * slower than the snapshot, and a reviewer should get the clinical picture as
 * soon as it is ready rather than waiting on the verdict. A failure here is
 * reported in place — it must never take the clinical view down with it, and it
 * must never be silently omitted, because a missing eligibility panel is
 * indistinguishable from a patient who has not been assessed.
 */
function EligibilitySection({ patientId }: { patientId: string }): ReactNode {
  const assessment = useAsync((signal) => fetchEligibility(patientId, undefined, signal), [
    patientId,
  ]);

  if (assessment.error) {
    return (
      <section className="verdict-bar verdict--alert">
        <div className="verdict-bar__main">
          <div className="verdict-bar__label">Bariatric surgery eligibility</div>
          <div className="verdict-bar__word">Unavailable</div>
          {/*
            Reported in place rather than omitted: a missing eligibility bar is
            indistinguishable from a patient nobody has assessed.
          */}
          <p className="verdict__rationale">Eligibility could not be computed: {assessment.error}</p>
        </div>
      </section>
    );
  }

  if (!assessment.data) {
    return (
      <section className="verdict-bar">
        <div className="verdict-bar__main">
          <div className="verdict-bar__label">Bariatric surgery eligibility</div>
          <div className="verdict-bar__word">
            <span className="skeleton skeleton--metric" />
          </div>
        </div>
      </section>
    );
  }

  return <Eligibility assessment={assessment.data} />;
}

function PatientView({ patientId }: { patientId: string }): ReactNode {
  const snapshot = useAsync((signal) => fetchSnapshot(patientId, signal), [patientId]);

  if (snapshot.error) return <div className="banner banner--error">{snapshot.error}</div>;

  if (!snapshot.data) {
    return (
      <>
        {/*
          The skeleton is decorative and aria-hidden, so the state change is
          announced here instead — a screen reader user gets "Loading patient
          record" rather than silence.
        */}
        <p className="visually-hidden" role="status">
          Loading patient record…
        </p>
        <SnapshotSkeleton />
      </>
    );
  }

  return (
    <>
      {/*
        The determination leads. This is a prior-authorization tool: the reviewer
        is here to answer one question, and the snapshot below is the context
        that supports it rather than the other way round.
      */}
      <EligibilitySection patientId={patientId} />
      <Snapshot snapshot={snapshot.data} />
      <Timeline patientId={patientId} />
    </>
  );
}

type View = 'patient' | 'cohort';

export function App(): ReactNode {
  const [patientId, setPatientId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>('patient');

  /** Selecting a patient implies wanting to see them, so it leaves the report. */
  const selectPatient = (id: string): void => {
    setPatientId(id);
    setView('patient');
  };

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="masthead__title">Prior Authorization Review</h1>
        <span className="hint">FHIR bulk export · read-only</span>
        <nav className="masthead__views" aria-label="View">
          <button
            type="button"
            className={view === 'patient' ? 'button button--on' : 'button'}
            aria-pressed={view === 'patient'}
            onClick={() => setView('patient')}
          >
            Patient review
          </button>
          <button
            type="button"
            className={view === 'cohort' ? 'button button--on' : 'button'}
            aria-pressed={view === 'cohort'}
            onClick={() => setView('cohort')}
          >
            Cohort report
          </button>
        </nav>
        <StoreBadge />
      </header>

      <div className="app__body">
        <PatientSelector selectedId={patientId} onSelect={selectPatient} />

        <main className="main">
          {view === 'cohort' ? (
            <CohortReport />
          ) : patientId ? (
            // `key` is load-bearing — see PatientView.
            <PatientView key={patientId} patientId={patientId} />
          ) : (
            <div className="banner">
              Select a patient to review their eligibility, clinical snapshot and timeline — or open
              the cohort report for the whole population.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
