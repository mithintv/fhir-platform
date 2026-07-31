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
import { fetchSnapshot, fetchStoreMeta, useAsync } from './lib/api';
import { formatCount } from './lib/format';
import { PatientSelector } from './components/PatientSelector';
import { Snapshot } from './components/Snapshot';
import { Timeline } from './components/Timeline';
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
      <Snapshot snapshot={snapshot.data} />
      <Timeline patientId={patientId} />
    </>
  );
}

export function App(): ReactNode {
  const [patientId, setPatientId] = useState<string | undefined>(undefined);

  return (
    <div className="app">
      <header className="masthead">
        <h1 className="masthead__title">Prior Authorization Review</h1>
        <span className="hint">FHIR bulk export · read-only</span>
        <StoreBadge />
      </header>

      <div className="app__body">
        <PatientSelector selectedId={patientId} onSelect={setPatientId} />

        <main className="main">
          {patientId ? (
            // `key` is load-bearing — see PatientView.
            <PatientView key={patientId} patientId={patientId} />
          ) : (
            <div className="banner">
              Select a patient to review their clinical snapshot and timeline.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
