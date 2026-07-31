/**
 * The chronological timeline: Observations and Procedures for one patient.
 *
 * Paged server-side rather than fetched whole. The busiest patient in this
 * dataset holds 29,539 resources, so "load the timeline" is not a single
 * response — and a UI that quietly renders only the first slice of a longer
 * history is the same class of error as one that hides missing data.
 */
import type { Db } from '../store/db.js';
import type { TimelineEntry, TimelinePage, TimelineResourceType } from './dto.js';
import type { NormalizedResource } from '../model/types.js';
import { parseRecord, toTimelineEntry } from './hydrate.js';

/** The only types this view shows, per the brief. */
export const TIMELINE_TYPES: readonly TimelineResourceType[] = ['Observation', 'Procedure'];

const MAX_LIMIT = 200;

export interface TimelineOptions {
  /** Subset of {@link TIMELINE_TYPES}. Empty or absent means both. */
  types?: readonly TimelineResourceType[];
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

interface TimelineRow {
  id: string;
  resource_type: TimelineResourceType;
  json: string;
}

/** Drops anything not in {@link TIMELINE_TYPES}, so `?types=Patient` cannot widen the query. */
function resolveTypes(requested: readonly TimelineResourceType[] | undefined): TimelineResourceType[] {
  if (!requested || requested.length === 0) return [...TIMELINE_TYPES];
  const allowed = requested.filter((type) => TIMELINE_TYPES.includes(type));
  return allowed.length > 0 ? allowed : [...TIMELINE_TYPES];
}

/**
 * Reads one page of the timeline.
 *
 * Undated rows sort last in both directions. Ordering them by a missing date
 * would place them at an arbitrary end of the history and imply a position they
 * do not have; `undated` in the response says how many there are so the UI can
 * state it rather than the user inferring it from a gap.
 */
export function getTimeline(
  db: Db,
  patientId: string,
  options: TimelineOptions = {},
): TimelinePage {
  const types = resolveTypes(options.types);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_LIMIT);
  const offset = Math.max(options.offset ?? 0, 0);
  const order = options.order === 'asc' ? 'asc' : 'desc';

  const placeholders = types.map(() => '?').join(',');

  const counts = db
    .prepare(
      `SELECT resource_type AS resourceType,
              count(*) AS count,
              sum(effective_sort IS NULL) AS undated
         FROM resource
        WHERE patient_id = ? AND resource_type IN (${placeholders})
        GROUP BY resource_type`,
    )
    .all(patientId, ...types) as unknown as {
    resourceType: TimelineResourceType;
    count: number;
    undated: number;
  }[];

  // Both types are reported even at zero, so a filter chip can show "0" rather
  // than vanishing when a patient happens to have no procedures.
  const countsByType: Record<TimelineResourceType, number> = { Observation: 0, Procedure: 0 };
  let total = 0;
  let undated = 0;
  for (const row of counts) {
    countsByType[row.resourceType] = row.count;
    total += row.count;
    undated += Number(row.undated);
  }

  const rows = db
    .prepare(
      `SELECT id, resource_type, json
         FROM resource
        WHERE patient_id = ? AND resource_type IN (${placeholders})
        ORDER BY (effective_sort IS NULL), effective_sort ${order === 'asc' ? 'ASC' : 'DESC'}, id
        LIMIT ? OFFSET ?`,
    )
    .all(patientId, ...types, limit, offset) as unknown as TimelineRow[];

  const entries: TimelineEntry[] = rows.map((row) =>
    toTimelineEntry(
      parseRecord<NormalizedResource>(row.json, `${row.resource_type}/${row.id}`),
      row.resource_type,
    ),
  );

  return { entries, total, limit, offset, order, undated, countsByType };
}

/**
 * Resolves a `ResourceType/id` citation back to its stored record.
 *
 * This is the drill-down behind a timeline row, and the same lookup Part D's
 * grounding check needs — which is why the ingest verifies that resource ids
 * are unique per type.
 */
export function getResource(
  db: Db,
  resourceType: string,
  id: string,
): NormalizedResource | undefined {
  const row = db
    .prepare('SELECT json FROM resource WHERE resource_type = ? AND id = ?')
    .get(resourceType, id) as { json: string } | undefined;
  return row ? parseRecord<NormalizedResource>(row.json, `${resourceType}/${id}`) : undefined;
}
