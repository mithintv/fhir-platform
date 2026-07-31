/**
 * Defensive accessors for raw FHIR JSON.
 *
 * Bulk exports are produced by many different servers and routinely contain
 * fields that are absent, null, the wrong JSON type, or an object where the
 * spec says array (and vice versa). Every read of raw data goes through these
 * helpers so a malformed field degrades to `undefined` instead of throwing and
 * killing the whole ingest run.
 */

export type Json = unknown;
export type JsonObject = Record<string, unknown>;

/** True for a plain JSON object. Arrays and `null` are excluded. */
export function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a non-empty string, trimming surrounding whitespace. */
export function str(value: Json): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads a finite number. Numeric strings are accepted; NaN/Infinity are not. */
export function num(value: Json): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Reads a boolean. The strings `"true"`/`"false"` are accepted too. */
export function bool(value: Json): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * Coerces to an array. FHIR cardinality is frequently violated in the wild
 * (a single object where `0..*` is declared), so a lone value becomes `[value]`.
 * Null/undefined entries are dropped.
 */
export function arr(value: Json): unknown[] {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && entry !== undefined);
  if (value === null || value === undefined) return [];
  return [value];
}

/** Array of objects only — the common shape for FHIR backbone elements. */
export function objArr(value: Json): JsonObject[] {
  return arr(value).filter(isObject);
}

/**
 * Reads `source[key]` without inheriting from Object.prototype. Numeric keys
 * index into arrays, so paths like `context.encounter.0` work.
 */
export function get(source: Json, key: string): Json {
  if (Array.isArray(source)) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 ? source[index] : undefined;
  }
  if (!isObject(source)) return undefined;
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/** Reads a nested path, tolerating missing links: `path(r, 'code', 'text')`. */
export function path(source: Json, ...keys: string[]): Json {
  let current: Json = source;
  for (const key of keys) {
    current = get(current, key);
    if (current === undefined || current === null) return undefined;
  }
  return current;
}

/** Drops undefined values so serialized output stays compact. */
export function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
