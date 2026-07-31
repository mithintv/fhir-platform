/**
 * API routing, as a pure function of (method, path, query) -> (status, body).
 *
 * Deliberately free of `node:http`: the routing table, the parameter coercion
 * and the 404/400 decisions are the parts worth testing, and none of them need
 * a socket. `server.ts` is the only file that knows about requests.
 */
import type { Db } from '../store/db.js';
import type { TimelineResourceType } from '../query/dto.js';
import { getClinicalSnapshot } from '../query/snapshot.js';
import { getStoreMeta } from '../query/meta.js';
import { searchPatients } from '../query/patients.js';
import { getResource, getTimeline, TIMELINE_TYPES } from '../query/timeline.js';
import { assessCohort, assessPatient } from '../eligibility/index.js';

export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Error bodies share one shape so the client has a single failure branch. */
function fail(status: number, error: string, detail?: string): ApiResponse {
  return { status, body: detail === undefined ? { error } : { error, detail } };
}

/**
 * Reads a non-negative integer query parameter.
 *
 * An unparseable value is rejected rather than silently defaulted: `?limit=abc`
 * quietly becoming 50 hides a client bug behind plausible-looking output.
 */
function intParam(
  params: URLSearchParams,
  name: string,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const raw = params.get(name);
  if (raw === null || raw === '') return { ok: true, value: undefined };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, message: `${name} must be a non-negative integer, got "${raw}"` };
  }
  return { ok: true, value };
}

/** Parses `?types=Observation,Procedure`, rejecting anything outside the view. */
function typesParam(
  params: URLSearchParams,
): { ok: true; value: TimelineResourceType[] | undefined } | { ok: false; message: string } {
  const raw = params.get('types');
  if (raw === null || raw.trim() === '') return { ok: true, value: undefined };

  const requested = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = requested.filter(
    (type) => !TIMELINE_TYPES.includes(type as TimelineResourceType),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `unsupported types: ${unknown.join(', ')} (allowed: ${TIMELINE_TYPES.join(', ')})`,
    };
  }
  return { ok: true, value: requested as TimelineResourceType[] };
}

/**
 * Reads the `?asOf=` review date.
 *
 * Absent means "let the policy choose", which resolves to the store's data
 * horizon — see `resolveAsOf`. A malformed value is rejected rather than
 * ignored: silently falling back to the default would score the cohort against
 * a different date than the caller asked for and label it as if it had not.
 */
function asOfParam(
  params: URLSearchParams,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const raw = params.get('asOf');
  if (raw === null || raw.trim() === '') return { ok: true, value: undefined };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    return { ok: false, message: `asOf must be a YYYY-MM-DD date, got "${raw}"` };
  }
  return { ok: true, value: raw };
}

/**
 * Resolves one request.
 *
 * `now` is injected so snapshot ages are deterministic under test.
 */
export function route(
  db: Db,
  method: string,
  pathname: string,
  params: URLSearchParams,
  now: Date = new Date(),
): ApiResponse {
  if (method !== 'GET') return fail(405, 'method-not-allowed', `${method} is not supported`);

  // Split once; every route below is a match on this segment list.
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'api') return fail(404, 'not-found', pathname);

  // GET /api/meta
  if (segments.length === 2 && segments[1] === 'meta') {
    return { status: 200, body: getStoreMeta(db) };
  }

  // GET /api/patients?q=&limit=&offset=
  if (segments.length === 2 && segments[1] === 'patients') {
    const limit = intParam(params, 'limit');
    if (!limit.ok) return fail(400, 'bad-request', limit.message);
    const offset = intParam(params, 'offset');
    if (!offset.ok) return fail(400, 'bad-request', offset.message);

    return {
      status: 200,
      body: searchPatients(db, {
        query: params.get('q') ?? undefined,
        limit: limit.value,
        offset: offset.value,
      }),
    };
  }

  // GET /api/patients/:id/snapshot
  if (segments.length === 4 && segments[1] === 'patients' && segments[3] === 'snapshot') {
    const patientId = decodeURIComponent(segments[2] as string);
    const snapshot = getClinicalSnapshot(db, patientId, now);
    return snapshot
      ? { status: 200, body: snapshot }
      : fail(404, 'patient-not-found', patientId);
  }

  // GET /api/cohort/eligibility?asOf=
  //
  // Ahead of the /api/patients routes only in reading order; the segment match
  // below is exact, so ordering between them carries no meaning.
  if (segments.length === 3 && segments[1] === 'cohort' && segments[2] === 'eligibility') {
    const asOf = asOfParam(params);
    if (!asOf.ok) return fail(400, 'bad-request', asOf.message);
    return { status: 200, body: assessCohort(db, { requested: asOf.value }).report };
  }

  // GET /api/patients/:id/eligibility?asOf=
  if (segments.length === 4 && segments[1] === 'patients' && segments[3] === 'eligibility') {
    const patientId = decodeURIComponent(segments[2] as string);
    const asOf = asOfParam(params);
    if (!asOf.ok) return fail(400, 'bad-request', asOf.message);

    const assessment = assessPatient(db, patientId, { requested: asOf.value });
    return assessment
      ? { status: 200, body: assessment }
      : fail(404, 'patient-not-found', patientId);
  }

  // GET /api/patients/:id/timeline?types=&limit=&offset=&order=
  if (segments.length === 4 && segments[1] === 'patients' && segments[3] === 'timeline') {
    const patientId = decodeURIComponent(segments[2] as string);

    const limit = intParam(params, 'limit');
    if (!limit.ok) return fail(400, 'bad-request', limit.message);
    const offset = intParam(params, 'offset');
    if (!offset.ok) return fail(400, 'bad-request', offset.message);
    const types = typesParam(params);
    if (!types.ok) return fail(400, 'bad-request', types.message);

    const order = params.get('order');
    if (order !== null && order !== 'asc' && order !== 'desc') {
      return fail(400, 'bad-request', `order must be "asc" or "desc", got "${order}"`);
    }

    // 404 before paging, so an unknown id is not reported as an empty timeline.
    const exists = db.prepare('SELECT 1 FROM patient WHERE id = ?').get(patientId);
    if (!exists) return fail(404, 'patient-not-found', patientId);

    return {
      status: 200,
      body: getTimeline(db, patientId, {
        types: types.value,
        limit: limit.value,
        offset: offset.value,
        order: order ?? 'desc',
      }),
    };
  }

  // GET /api/resources/:resourceType/:id — the citation drill-down.
  if (segments.length === 4 && segments[1] === 'resources') {
    const resourceType = decodeURIComponent(segments[2] as string);
    const id = decodeURIComponent(segments[3] as string);
    const resource = getResource(db, resourceType, id);
    return resource
      ? { status: 200, body: resource }
      : fail(404, 'resource-not-found', `${resourceType}/${id}`);
  }

  return fail(404, 'not-found', pathname);
}
