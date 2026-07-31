/**
 * Tests for the routing table.
 *
 * `route` was a pure function of (method, path, query) until Part D, when one
 * route became asynchronous and the API stopped being GET-only. Both of those
 * are easy to get subtly wrong in a way nothing else would catch: a
 * per-route method check can accidentally open every read endpoint to POST, and
 * a route that returns a promise can be serialized as `{}` by a caller that
 * forgot to await it. Hence this file.
 *
 * The store is a fixture, and the assist route runs against the default offline
 * provider, so nothing here needs credentials or a socket.
 */
import { describe, expect, it } from 'vitest';
import { buildFixtureStore, observation, patient } from '../query/fixture.js';
import type { AssistResult } from '../assist/dto.js';
import { route } from './routes.js';

const AS_OF = '2023-01-01';
const NOW = new Date('2023-01-01T00:00:00Z');

const db = buildFixtureStore([
  patient(),
  observation('bmi1', '39156-5', '2022-06-01T10:00:00Z', { value: 41.7, unit: 'kg/m2' }),
]);

const call = (method: string, path: string, query = ''): ReturnType<typeof route> =>
  route(db, method, path, new URLSearchParams(query), NOW);

describe('method handling', () => {
  it.each([
    '/api/meta',
    '/api/patients',
    '/api/patients/p1/snapshot',
    '/api/patients/p1/timeline',
    '/api/patients/p1/eligibility',
    '/api/cohort/eligibility',
    '/api/resources/Observation/bmi1',
  ])('still refuses POST on %s', (path) => {
    const response = call('POST', path);
    expect(response).not.toBeInstanceOf(Promise);
    expect((response as { status: number }).status).toBe(405);
  });

  it('refuses GET on the assist route, which is the one route that spends money', () => {
    const response = call('GET', '/api/patients/p1/assist');
    expect((response as { status: number }).status).toBe(405);
    expect((response as { body: { detail: string } }).body.detail).toContain('use POST');
  });
});

describe('POST /api/patients/:id/assist', () => {
  it('returns a complete assist result', async () => {
    const response = await call('POST', '/api/patients/p1/assist', `asOf=${AS_OF}`);

    expect(response.status).toBe(200);
    const body = response.body as AssistResult;
    expect(body.patientRef).toBe('Patient/p1');
    expect(body.checklist).toHaveLength(4);
    expect(body.eligibilityAssessment).toBe('unknown');
    expect(body.provenance.kind).toBe('model');
  });

  it('404s an unknown patient rather than explaining an empty record', async () => {
    const response = await call('POST', '/api/patients/nobody/assist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'patient-not-found', detail: 'nobody' });
  });

  it('rejects a malformed review date instead of silently using the default', () => {
    // Synchronous on purpose: the parameter is rejected before the model layer
    // is reached, so this must not return a promise.
    const response = call('POST', '/api/patients/p1/assist', 'asOf=yesterday');

    expect(response).not.toBeInstanceOf(Promise);
    expect((response as { status: number }).status).toBe(400);
  });

  it('scores against an explicit review date when one is given', async () => {
    const response = await call('POST', '/api/patients/p1/assist', 'asOf=2025-06-01');

    const body = response.body as AssistResult;
    expect(body.provenance.asOf).toBe('2025-06-01');
    // The 2022 BMI now predates the 24-month window, so the arm is unresolved
    // rather than met — proof the parameter reached the evaluator rather than
    // being parsed and dropped.
    expect(body.checklist[0]?.status).toBe('unknown');
  });
});

describe('unmatched paths', () => {
  it.each([['/'], ['/api'], ['/api/nothing'], ['/api/patients/p1/assist/extra']])(
    '404s GET %s',
    (path) => {
      expect((call('GET', path) as { status: number }).status).toBe(404);
    },
  );

  // Pre-existing and unchanged by Part D: the method check runs before the
  // 404, so a non-GET at a path that does not exist reports the method rather
  // than the path. Asserted so the ordering is a decision rather than a
  // surprise the next person rediscovers.
  it('reports 405 before 404 for a non-GET at an unknown path', () => {
    expect((call('POST', '/api/patients/p1/assist/extra') as { status: number }).status).toBe(405);
  });
});
