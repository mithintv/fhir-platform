/**
 * Patient selector: search by name or id, paged.
 *
 * Search is server-side. It would be tempting to fetch all 1,132 patients once
 * and filter in the browser, and at this size that would work — but it makes
 * the component's correctness depend on the dataset staying small, and the same
 * screen is meant to survive a real panel of patients.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { fetchPatients, useAsync, useDebounced } from '../lib/api';
import { formatCount } from '../lib/format';
import { AsyncState, Missing } from './primitives';

const PAGE_SIZE = 50;

export function PatientSelector({
  selectedId,
  onSelect,
}: {
  selectedId: string | undefined;
  onSelect: (patientId: string) => void;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const debouncedQuery = useDebounced(query);

  const results = useAsync(
    (signal) =>
      fetchPatients({ query: debouncedQuery, limit: PAGE_SIZE, offset }, signal),
    [debouncedQuery, offset],
  );

  // A new search starts from the first page; keeping the old offset would show
  // an empty page for a query with fewer matches than the current position.
  const changeQuery = (value: string): void => {
    setQuery(value);
    setOffset(0);
  };

  const total = results.data?.total ?? 0;
  const shown = results.data?.items.length ?? 0;

  return (
    <div className="sidebar">
      <div className="selector__header">
        <span className="selector__label">Patient</span>
      </div>

      <div className="selector__search">
        <label className="visually-hidden" htmlFor="patient-search">
          Search patients by name or ID
        </label>
        <input
          id="patient-search"
          className="search-input"
          type="search"
          placeholder="Search by name or ID…"
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="selector__list">
        <AsyncState
          loading={results.loading && !results.data}
          error={results.error}
          empty={results.data !== undefined && shown === 0}
          emptyLabel={`No patient matches “${debouncedQuery}”.`}
        >
          {results.data?.items.map((patient) => (
            <button
              key={patient.id}
              type="button"
              className="patient-row"
              aria-selected={patient.id === selectedId}
              onClick={() => onSelect(patient.id)}
            >
              <div className="patient-row__name">
                {patient.name ?? (
                  <Missing
                    label="Unnamed patient"
                    reason="The Patient resource carried no usable name element."
                  />
                )}
              </div>
              <div className="patient-row__detail">
                <span>{patient.gender ?? '—'}</span>
                <span>{patient.birthDate ?? 'DOB unknown'}</span>
                {patient.deceased ? <span className="tag tag--alert">deceased</span> : null}
              </div>
              <div className="patient-row__id">{patient.id}</div>
            </button>
          ))}
        </AsyncState>
      </div>

      <div className="selector__footer">
        <button
          type="button"
          className="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          ←
        </button>
        <span>
          {total === 0
            ? '0 patients'
            : `${formatCount(offset + 1)}–${formatCount(offset + shown)} of ${formatCount(total)}`}
        </span>
        <button
          type="button"
          className="button"
          disabled={offset + shown >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          →
        </button>
      </div>
    </div>
  );
}
