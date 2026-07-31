/**
 * Shared display primitives.
 *
 * `Missing` is the important one. Every place a value could be absent renders
 * it instead of an empty string, which makes "the record does not say" a
 * visible, uniform, explainable state rather than a blank cell that looks
 * identical to a rendering bug. It carries a `reason` so hovering explains what
 * specifically was looked for and not found.
 */
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { DateInfo } from '../lib/api';
import { formatDate, precisionNote } from '../lib/format';

export function Missing({
  label = 'Not recorded',
  reason,
}: {
  label?: string;
  reason?: string;
}): ReactNode {
  return (
    <span className="missing" title={reason ?? 'This field is absent from the source FHIR record.'}>
      {label}
    </span>
  );
}

/**
 * A date, at its recorded precision, with a note when that precision is partial.
 *
 * The note is the point: `2013` and `2013-07-20` both being rendered as dates
 * hides that one of them is a whole year wide.
 */
export function FhirDate({
  date,
  reason,
}: {
  date: DateInfo | null;
  reason?: string;
}): ReactNode {
  if (!date) return <Missing label="No date" reason={reason ?? 'This resource carries no usable date on any type-appropriate element.'} />;

  const note = precisionNote(date);
  return (
    <>
      <span title={date.value}>{formatDate(date)}</span>
      {note ? <span className="tag tag--gap" style={{ marginLeft: 6 }}>{note}</span> : null}
    </>
  );
}

/** A `ResourceType/id` citation, styled as an identifier. */
export function ResourceRef({ refValue }: { refValue: string }): ReactNode {
  return (
    <span className="table__ref" title={refValue}>
      {refValue}
    </span>
  );
}

/** A labelled fact in the demographics strip. */
export function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="fact">
      <div className="fact__label">{label}</div>
      <div className="fact__value">{children}</div>
    </div>
  );
}

export function Panel({
  title,
  note,
  actions,
  flush,
  children,
}: {
  title: string;
  note?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">{title}</h2>
        {note ? <span className="panel__note">{note}</span> : null}
        {actions ? <div className="panel__actions">{actions}</div> : null}
      </div>
      <div className={flush ? 'panel__body panel__body--flush' : 'panel__body'}>{children}</div>
    </section>
  );
}

/** The three states of a request, so no component invents its own spinner. */
export function AsyncState({
  loading,
  error,
  empty,
  emptyLabel,
  children,
}: {
  loading: boolean;
  error: string | undefined;
  empty?: boolean;
  emptyLabel?: string;
  children: ReactNode;
}): ReactNode {
  if (error) return <div className="banner banner--error">{error}</div>;
  if (loading) return <div className="empty">Loading…</div>;
  if (empty) return <div className="empty">{emptyLabel ?? 'Nothing to show.'}</div>;
  return <>{children}</>;
}

/**
 * A right-anchored, full-height drawer.
 *
 * Modal rather than a slide-out that leaves the page live behind it: the
 * eligibility checklist is a decision surface, and a reviewer working through
 * it should not be able to change the selected patient underneath it and end up
 * reading one patient's requirements beside another's chart.
 *
 * The keyboard contract is the part that is easy to skip and shouldn't be:
 * Escape closes, focus moves into the drawer on open and returns to whatever
 * opened it on close, and the background scroll is locked so the page behind
 * does not drift while the drawer is scrolled.
 */
export function Drawer({
  open,
  title,
  note,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  note?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Guarded: the element that opened the drawer may have unmounted with a
      // patient switch, and focusing a detached node throws focus to <body>.
      if (restoreFocusTo.current?.isConnected) restoreFocusTo.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-layer">
      {/*
        The scrim is a button, not a div with onClick: click-to-dismiss should
        not be the only way out, and making it focusable-and-labelled means the
        affordance exists for a keyboard user too.
      */}
      <button
        type="button"
        className="drawer__scrim"
        aria-label={`Close ${title}`}
        onClick={onClose}
      />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <div className="drawer__head">
          <h2 className="drawer__title">{title}</h2>
          {note ? <span className="panel__note">{note}</span> : null}
          <button type="button" className="button drawer__close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="drawer__body">{children}</div>
      </div>
    </div>
  );
}

/**
 * Placeholder shown while a patient's snapshot loads.
 *
 * Shaped like the panels it stands in for, so the main column keeps its height
 * and the page does not jump when the real content arrives. Purely decorative,
 * so it is hidden from assistive technology — the live region in `PatientView`
 * is what announces the state change.
 */
export function SnapshotSkeleton(): ReactNode {
  return (
    <div aria-hidden="true">
      <section className="panel">
        <div className="patient-head">
          <span className="skeleton skeleton--title" />
        </div>
        <div className="facts">
          {Array.from({ length: 6 }, (_, index) => (
            <div className="fact" key={index}>
              <span className="skeleton skeleton--label" />
              <span className="skeleton skeleton--value" />
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="skeleton skeleton--label" />
        </div>
        <div className="metrics">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="metric" key={index}>
              <span className="skeleton skeleton--label" />
              <span className="skeleton skeleton--metric" />
              <span className="skeleton skeleton--label" />
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <span className="skeleton skeleton--label" />
        </div>
        <div className="panel__body">
          {Array.from({ length: 5 }, (_, index) => (
            <span className="skeleton skeleton--row" key={index} />
          ))}
        </div>
      </section>
    </div>
  );
}
