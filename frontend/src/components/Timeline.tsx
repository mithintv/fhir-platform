/**
 * The chronological timeline of Observations and Procedures.
 *
 * Paged against the API rather than loaded whole: the busiest patient in this
 * dataset has 22,827 timeline resources, and rendering that as one list would
 * be both slow and dishonest about where the history ends.
 *
 * Every row shows the three things the brief asks for — display name, date, and
 * source FHIR resource ID — plus the observation's value, which is what makes a
 * row about a BMI reading actually readable as clinical information.
 */
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { TimelineResourceType } from '../lib/api';
import { fetchTimeline, useAsync } from '../lib/api';
import { formatCount, humanizeCode } from '../lib/format';
import { AsyncState, FhirDate, Missing, Panel } from './primitives';

const PAGE_SIZE = 100;
const ALL_TYPES: TimelineResourceType[] = ['Observation', 'Procedure'];

export function Timeline({ patientId }: { patientId: string }): ReactNode {
  const [types, setTypes] = useState<TimelineResourceType[]>(ALL_TYPES);
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  // Switching patients must reset paging: page 40 of the previous patient's
  // history is a meaningless position in the next patient's.
  useEffect(() => {
    setOffset(0);
  }, [patientId]);

  const page = useAsync(
    (signal) => fetchTimeline(patientId, { types, order, limit: PAGE_SIZE, offset }, signal),
    [patientId, types.join(','), order, offset],
  );

  const toggleType = (type: TimelineResourceType): void => {
    setOffset(0);
    setTypes((current) => {
      const next = current.includes(type)
        ? current.filter((entry) => entry !== type)
        : [...current, type];
      // Deselecting everything would silently mean "show all" on the server;
      // keeping at least one selected keeps the filter honest.
      return next.length === 0 ? current : next;
    });
  };

  const changeOrder = (next: 'asc' | 'desc'): void => {
    setOffset(0);
    setOrder(next);
  };

  const data = page.data;
  const shown = data?.entries.length ?? 0;
  const total = data?.total ?? 0;

  return (
    <Panel
      title="Timeline"
      note={
        data
          ? `${formatCount(total)} resources${data.undated > 0 ? ` · ${formatCount(data.undated)} undated, listed last` : ''}`
          : undefined
      }
      actions={
        <>
          {ALL_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className={types.includes(type) ? 'button button--on' : 'button'}
              onClick={() => toggleType(type)}
              aria-pressed={types.includes(type)}
            >
              {type}
              {data ? ` ${formatCount(data.countsByType[type])}` : ''}
            </button>
          ))}
          <button
            type="button"
            className="button"
            onClick={() => changeOrder(order === 'desc' ? 'asc' : 'desc')}
            title={order === 'desc' ? 'Newest first' : 'Oldest first'}
          >
            {order === 'desc' ? 'Newest first ↓' : 'Oldest first ↑'}
          </button>
        </>
      }
      flush
    >
      <AsyncState
        loading={page.loading && !data}
        error={page.error}
        empty={data !== undefined && shown === 0}
        emptyLabel="No Observations or Procedures for this patient."
      >
        <div className="scroll-x">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Name</th>
                <th>Value</th>
                <th>Status</th>
                <th>Source ID</th>
              </tr>
            </thead>
            <tbody>
              {data?.entries.map((entry) => (
                <tr key={entry.ref}>
                  <td className="table__date">
                    <FhirDate date={entry.date} />
                  </td>
                  <td>
                    <span className="tag tag--type">{entry.resourceType}</span>
                  </td>
                  <td className="table__name">
                    {entry.display ?? (
                      <Missing
                        label="No code"
                        reason={`This ${entry.resourceType} carries no code element, so it has no display name.`}
                      />
                    )}
                    {entry.category ? <div className="hint">{entry.category}</div> : null}
                  </td>
                  <td className="table__value">
                    {entry.value ??
                      (entry.resourceType === 'Observation' ? (
                        <Missing
                          label="No value"
                          reason="This Observation records no value element and no components."
                        />
                      ) : (
                        <span className="hint">—</span>
                      ))}
                  </td>
                  <td>
                    {entry.status ? (
                      <span className="tag">{humanizeCode(entry.status)}</span>
                    ) : (
                      <Missing label="Not stated" reason="This resource has no status element." />
                    )}
                  </td>
                  <td className="table__ref">{entry.ref}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="selector__footer">
          <button
            type="button"
            className="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← Newer page
          </button>
          <span>
            {total === 0
              ? '0'
              : `${formatCount(offset + 1)}–${formatCount(offset + shown)} of ${formatCount(total)}`}
          </span>
          <button
            type="button"
            className="button"
            disabled={offset + shown >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Older page →
          </button>
          {page.loading ? <span className="hint">updating…</span> : null}
        </div>
      </AsyncState>
    </Panel>
  );
}
