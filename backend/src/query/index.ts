/**
 * Public surface of the read-only query layer.
 *
 * The API server and the tests both go through here, so the set of things the
 * frontend can ask for is visible in one file.
 */
export * from './dto.js';
export { METRIC_PANEL, PANEL_CODES, LOINC } from './codes.js';
export { computeAge, getPatientRecord, searchPatients, toDemographics } from './patients.js';
export type { SearchOptions } from './patients.js';
export { getClinicalSnapshot } from './snapshot.js';
export { getResource, getTimeline, TIMELINE_TYPES } from './timeline.js';
export type { TimelineOptions } from './timeline.js';
export { getStoreMeta } from './meta.js';
