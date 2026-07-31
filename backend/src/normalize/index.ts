/**
 * Entry point for turning one raw FHIR resource into the internal model.
 */
import type { NormalizedPatient, NormalizedResource } from '../model/types.js';
import { buildEnvelope } from './envelope.js';
import { normalizePatient } from './patient.js';
import { DEFAULT_NORMALIZE_OPTIONS, RESOURCE_NORMALIZERS } from './resources.js';
import type { NormalizeOptions } from './resources.js';
import { isObject, path, str } from '../fhir/safe.js';
import type { Json } from '../fhir/safe.js';

export { DEFAULT_NORMALIZE_OPTIONS } from './resources.js';
export type { NormalizeOptions } from './resources.js';

export type NormalizeResult =
  | { kind: 'patient'; patient: NormalizedPatient }
  | { kind: 'resource'; resource: NormalizedResource }
  | { kind: 'skipped'; reason: SkipReason };

export type SkipReason =
  | 'not-an-object'
  | 'missing-resource-type'
  | 'missing-id'
  | 'filtered-resource-type'
  | 'operation-outcome';

/**
 * Normalizes a single parsed FHIR resource.
 *
 * `resourceTypeHint` comes from the NDJSON filename. Bulk exports name files
 * after the resource type they contain, but the hint is only a fallback: the
 * `resourceType` inside the resource always wins, because some servers mix
 * OperationOutcome entries into a type file to report row-level errors.
 */
export function normalizeResource(
  raw: Json,
  resourceTypeHint: string | undefined,
  options: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
  allowedTypes?: ReadonlySet<string>,
): NormalizeResult {
  if (!isObject(raw)) return { kind: 'skipped', reason: 'not-an-object' };

  const resourceType = str(path(raw, 'resourceType')) ?? resourceTypeHint;
  if (!resourceType) return { kind: 'skipped', reason: 'missing-resource-type' };

  // Bulk-export error rows are diagnostics about the export, not patient data.
  if (resourceType === 'OperationOutcome') return { kind: 'skipped', reason: 'operation-outcome' };

  if (allowedTypes && !allowedTypes.has(resourceType)) {
    return { kind: 'skipped', reason: 'filtered-resource-type' };
  }

  const id = str(path(raw, 'id'));
  if (!id) return { kind: 'skipped', reason: 'missing-id' };

  if (resourceType === 'Patient') {
    return { kind: 'patient', patient: normalizePatient(raw, id) };
  }

  const { envelope, issues } = buildEnvelope(raw, resourceType, id);
  const normalizer = RESOURCE_NORMALIZERS[resourceType];
  const resource = normalizer ? normalizer(raw, envelope, options) : envelope;
  const allIssues = [...issues, ...(resource.issues ?? [])];
  if (allIssues.length > 0) resource.issues = allIssues;

  return { kind: 'resource', resource };
}
