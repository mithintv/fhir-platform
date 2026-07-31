/**
 * FHIR date handling.
 *
 * FHIR `date` is deliberately imprecise: `2013`, `2013-07` and `2013-07-20` are
 * all legal and mean genuinely different things. We keep the original string so
 * the UI can show exactly what was recorded, and derive a sort key separately so
 * the timeline can order records without inventing precision it doesn't have.
 */
import type { NormalizedDate } from '../model/types.js';
import { num, path, str } from './safe.js';
import type { Json } from './safe.js';

const YEAR = /^\d{4}$/;
const YEAR_MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a FHIR date/dateTime/instant. Returns `undefined` for anything that
 * isn't a usable date rather than producing an Invalid Date.
 */
export function parseDate(value: Json): NormalizedDate | undefined {
  const raw = str(value);
  if (!raw) return undefined;

  let precision: NormalizedDate['precision'];
  let isoForSorting: string;

  if (YEAR.test(raw)) {
    precision = 'year';
    isoForSorting = `${raw}-01-01T00:00:00Z`;
  } else if (YEAR_MONTH.test(raw)) {
    precision = 'month';
    isoForSorting = `${raw}-01T00:00:00Z`;
  } else if (DATE.test(raw)) {
    precision = 'day';
    isoForSorting = `${raw}T00:00:00Z`;
  } else {
    precision = 'time';
    isoForSorting = raw;
  }

  const sortKey = Date.parse(isoForSorting);
  if (Number.isNaN(sortKey)) return undefined;

  return { value: raw, sortKey, precision };
}

/**
 * Picks the one date that places a resource on the timeline, trying each
 * type-appropriate FHIR element in clinical-preference order. Returns the
 * element name alongside the value so the UI can be honest about provenance
 * (a `recordedDate` is not the same claim as an `onsetDateTime`).
 */
export function pickEffectiveDate(
  resource: Json,
  candidates: readonly string[],
): { date: NormalizedDate; source: string } | undefined {
  for (const candidate of candidates) {
    const value = path(resource, ...candidate.split('.'));
    const date = parseDate(value);
    if (date) return { date, source: candidate };
  }
  return undefined;
}

/** Reads a `Period` into start/end dates. */
export function parsePeriod(value: Json): { start?: NormalizedDate; end?: NormalizedDate } {
  return { start: parseDate(path(value, 'start')), end: parseDate(path(value, 'end')) };
}
