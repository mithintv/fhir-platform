/**
 * Display formatting.
 *
 * The rule these functions exist to enforce: never render more precision than
 * the source recorded. FHIR dates are legitimately partial — `2013`, `2013-07`,
 * `2013-07-20` and a full instant are all valid and mean different things — and
 * the ingest preserved which one it was. Formatting a year-precision date as
 * "1 January 2013" invents a day the record never claimed.
 */
import type { DateInfo } from './api';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Formats a date at exactly the precision it was recorded at.
 *
 * Deliberately string-based rather than going through `Date`. Parsing
 * `"1961-02-11"` with `new Date()` yields UTC midnight, which in any timezone
 * west of Greenwich renders as the 10th — a patient's birthday silently moving
 * by a day is not an acceptable rounding error on a clinical screen. The stored
 * string already says what was recorded; this reformats it without a timezone
 * ever entering the picture.
 */
export function formatDate(date: DateInfo | null): string | null {
  if (!date) return null;

  const [datePart = '', timePart] = date.value.split('T');
  const [year, month, day] = datePart.split('-');
  if (!year) return date.value;

  switch (date.precision) {
    case 'year':
      return year;
    case 'month':
      return `${monthName(month)} ${year}`;
    case 'day':
      return `${Number(day)} ${monthName(month)} ${year}`;
    case 'time': {
      // Keep the clock time as recorded at the source; the offset is dropped
      // rather than converted, because "when the clinician wrote it" is the
      // useful reading, not the same instant in the viewer's timezone.
      const clock = (timePart ?? '').slice(0, 5);
      const base = `${Number(day)} ${monthName(month)} ${year}`;
      return clock ? `${base}, ${clock}` : base;
    }
  }
}

function monthName(month: string | undefined): string {
  const index = Number(month) - 1;
  return MONTHS[index] ?? month ?? '';
}

/**
 * A short note naming the precision, shown next to partial dates.
 *
 * Only returned for genuinely partial dates: labelling every full timestamp
 * would be noise, but a bare "2013" needs to be visibly a year and not a
 * truncated display.
 */
export function precisionNote(date: DateInfo | null): string | null {
  if (!date) return null;
  if (date.precision === 'year') return 'year only';
  if (date.precision === 'month') return 'month only';
  return null;
}

/** Thousands-separated integer. */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Sentence-cases a FHIR code such as `not-done` or `entered-in-error`. */
export function humanizeCode(code: string): string {
  const spaced = code.replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
