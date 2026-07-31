/**
 * The API client.
 *
 * Types are imported from the backend workspace package rather than restated
 * here, so a change to a response shape is a compile error in this app instead
 * of a runtime surprise. They are type-only imports: nothing from the backend
 * (and certainly not `node:sqlite`) is bundled into the browser.
 */
import { useCallback, useEffect, useState } from 'react';

export type {
  Age,
  ClinicalSnapshot,
  ConditionEntry,
  DateInfo,
  KeyObservation,
  ObservationMetric,
  ObservationReading,
  PatientDemographics,
  PatientListItem,
  PatientSearchResult,
  ProcedureEntry,
  ResourceMix,
  StoreMeta,
  TimelineEntry,
  TimelinePage,
  TimelineResourceType,
} from '@autonomy/backend/dto';

export type {
  CohortCategory,
  CohortReport,
  CohortUnknownCombination,
  CohortUnknownReason,
  Determination,
  EligibilityAssessment,
  EvidenceItem,
  PolicySummary,
  RequirementFinding,
  RequirementId,
  RequirementStatus,
  UnknownReason,
} from '@autonomy/backend/eligibility-dto';

import type { ClinicalSnapshot, PatientSearchResult, StoreMeta, TimelinePage } from '@autonomy/backend/dto';
import type { CohortReport, EligibilityAssessment } from '@autonomy/backend/eligibility-dto';

/** An API error carrying the status, so callers can distinguish 404 from 500. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

/**
 * Issues a GET and parses the JSON body.
 *
 * Error bodies share one shape (`{ error, detail }`), so failures surface with
 * the server's own explanation rather than a bare status code.
 */
async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: 'application/json' } });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: string; detail?: string }
      | null;
    throw new ApiError(response.status, body?.detail ?? body?.error ?? response.statusText);
  }

  return (await response.json()) as T;
}

export function fetchStoreMeta(signal?: AbortSignal): Promise<StoreMeta> {
  return get<StoreMeta>('/api/meta', signal);
}

export function fetchPatients(
  params: { query?: string; limit?: number; offset?: number },
  signal?: AbortSignal,
): Promise<PatientSearchResult> {
  const search = new URLSearchParams();
  if (params.query) search.set('q', params.query);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  return get<PatientSearchResult>(`/api/patients?${search}`, signal);
}

export function fetchSnapshot(patientId: string, signal?: AbortSignal): Promise<ClinicalSnapshot> {
  return get<ClinicalSnapshot>(`/api/patients/${encodeURIComponent(patientId)}/snapshot`, signal);
}

export function fetchTimeline(
  patientId: string,
  params: { types?: string[]; limit?: number; offset?: number; order?: 'asc' | 'desc' },
  signal?: AbortSignal,
): Promise<TimelinePage> {
  const search = new URLSearchParams();
  if (params.types?.length) search.set('types', params.types.join(','));
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  if (params.order) search.set('order', params.order);
  return get<TimelinePage>(
    `/api/patients/${encodeURIComponent(patientId)}/timeline?${search}`,
    signal,
  );
}

/**
 * The deterministic eligibility assessment for one patient.
 *
 * `asOf` is optional and normally omitted: the server anchors the review date to
 * the store's newest clinical date rather than to the browser's clock, and the
 * response says which it used.
 */
export function fetchEligibility(
  patientId: string,
  asOf?: string,
  signal?: AbortSignal,
): Promise<EligibilityAssessment> {
  const search = new URLSearchParams();
  if (asOf) search.set('asOf', asOf);
  return get<EligibilityAssessment>(
    `/api/patients/${encodeURIComponent(patientId)}/eligibility?${search}`,
    signal,
  );
}

export function fetchCohortReport(asOf?: string, signal?: AbortSignal): Promise<CohortReport> {
  const search = new URLSearchParams();
  if (asOf) search.set('asOf', asOf);
  return get<CohortReport>(`/api/cohort/eligibility?${search}`, signal);
}

/** What a component needs to render one request: the three states, explicitly. */
export interface Async<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

/**
 * Runs an async fetch, tracking loading and error state.
 *
 * The request is aborted when `deps` change or the component unmounts. Without
 * that, switching patients quickly lets a slow earlier response land after a
 * fast later one and paint the wrong patient's data — the exact failure the
 * "switching patients updates all views" requirement is about.
 */
export function useAsync<T>(
  run: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): Async<T> & { reload: () => void } {
  const [state, setState] = useState<Async<T>>({
    data: undefined,
    error: undefined,
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  // `run` is intentionally not a dependency: callers pass an inline closure, so
  // depending on it would re-fire every render. `deps` is the contract.
  const callback = useCallback(run, deps);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setState((previous) => ({ ...previous, loading: true, error: undefined }));

    callback(controller.signal)
      .then((data) => {
        if (active) setState({ data, error: undefined, loading: false });
      })
      .catch((error: unknown) => {
        // An abort is the expected outcome of switching patients, not a failure
        // to report.
        if (!active || controller.signal.aborted) return;
        setState({
          data: undefined,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [callback, nonce]);

  return { ...state, reload: () => setNonce((value) => value + 1) };
}

/** Debounces a value, so typing in the search box does not fire a request per keystroke. */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
