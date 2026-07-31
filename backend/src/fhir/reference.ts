/**
 * FHIR `Reference` resolution.
 *
 * A reference can appear in several forms, and this dataset contains at least
 * three of them:
 *   Patient/00f9e3dc-...                                   relative literal
 *   https://example.org/fhir/Patient/00f9e3dc-.../_history/2  absolute literal
 *   urn:uuid:0648c6c0-...                                  bundle-local uuid
 *   Location?identifier=https://synthea|b27f06bf-...       logical reference
 *   #contained-1                                           contained resource
 *   { "identifier": {...}, "type": "Practitioner" }        identifier-only
 *
 * Only the literal forms yield a logical id we can join on. Logical references
 * are preserved (not silently dropped) so the UI can still show the display
 * text and report that the target is unresolved.
 */
import type { NormalizedReference } from '../model/types.js';
import { compact, isObject, path, str } from './safe.js';
import type { Json } from './safe.js';

/** A FHIR resource type: capitalised ASCII word. */
const RESOURCE_TYPE = /^[A-Z][A-Za-z]+$/;

/**
 * Splits a literal reference tail (`Patient/123` or `Patient/123/_history/4`).
 * Returns undefined when the segments don't look like `Type/id`.
 */
function splitLiteral(tail: string): { resourceType: string; id: string } | undefined {
  const segments = tail.split('/').filter((segment) => segment.length > 0);
  const historyIndex = segments.indexOf('_history');
  const relevant = historyIndex === -1 ? segments : segments.slice(0, historyIndex);
  if (relevant.length < 2) return undefined;
  const id = relevant[relevant.length - 1];
  const resourceType = relevant[relevant.length - 2];
  if (!id || !resourceType || !RESOURCE_TYPE.test(resourceType)) return undefined;
  return { resourceType, id };
}

/** Parses `?identifier=system|value` (or `?identifier=value`) query syntax. */
function parseIdentifierQuery(query: string): { system?: string; value?: string } | undefined {
  const params = new URLSearchParams(query);
  const identifier = params.get('identifier');
  if (identifier === null) return undefined;
  // The token separator is the *last* `|`: identifier systems are URLs and may
  // themselves contain `|`-free but `/`-heavy text, while values rarely do.
  const separator = identifier.lastIndexOf('|');
  if (separator === -1) return { value: str(identifier) };
  return {
    system: str(identifier.slice(0, separator)),
    value: str(identifier.slice(separator + 1)),
  };
}

/**
 * Normalizes a `Reference` element. Accepts the element itself, or a bare
 * reference string.
 */
export function parseReference(value: Json): NormalizedReference | undefined {
  if (typeof value === 'string') return parseReferenceString(value);
  if (!isObject(value)) return undefined;

  const raw = str(path(value, 'reference'));
  const display = str(path(value, 'display'));
  const declaredType = str(path(value, 'type'));
  const identifierSystem = str(path(value, 'identifier', 'system'));
  const identifierValue = str(path(value, 'identifier', 'value'));

  if (raw) {
    const parsed = parseReferenceString(raw);
    if (parsed) {
      return compact({
        ...parsed,
        resourceType: parsed.resourceType ?? declaredType,
        display: display ?? parsed.display,
        identifier: parsed.identifier ?? identifierOf(identifierSystem, identifierValue),
      });
    }
  }

  // No `reference` string: an identifier-only logical reference is still usable
  // as evidence even though it cannot be joined to a local resource.
  const identifier = identifierOf(identifierSystem, identifierValue);
  if (identifier || display || declaredType) {
    return compact({
      form: 'logical' as const,
      resourceType: declaredType,
      identifier,
      display,
    });
  }
  return undefined;
}

/** Builds an identifier object, or `undefined` when both halves are missing. */
function identifierOf(system?: string, value?: string): { system?: string; value?: string } | undefined {
  if (!system && !value) return undefined;
  return compact({ system, value });
}

/**
 * Classifies a bare reference string into one of the forms listed at the top of
 * this file, extracting the logical id when the form carries one.
 *
 * Unrecognised strings are kept as `{ form: 'unknown' }` rather than discarded,
 * so the original text survives into the record for a human to inspect.
 */
export function parseReferenceString(input: string): NormalizedReference | undefined {
  const raw = str(input);
  if (!raw) return undefined;

  if (raw.startsWith('#')) {
    return { raw, form: 'contained', id: raw.slice(1) || undefined };
  }

  if (raw.toLowerCase().startsWith('urn:uuid:')) {
    return { raw, form: 'urn-uuid', id: raw.slice('urn:uuid:'.length) || undefined };
  }

  if (raw.toLowerCase().startsWith('urn:oid:')) {
    return { raw, form: 'urn-uuid', id: raw.slice('urn:oid:'.length) || undefined };
  }

  const queryIndex = raw.indexOf('?');
  if (queryIndex !== -1) {
    const head = raw.slice(0, queryIndex);
    const resourceType = head.split('/').filter(Boolean).pop();
    return compact({
      raw,
      form: 'logical' as const,
      resourceType: resourceType && RESOURCE_TYPE.test(resourceType) ? resourceType : undefined,
      identifier: parseIdentifierQuery(raw.slice(queryIndex + 1)),
    });
  }

  const isAbsolute = /^https?:\/\//i.test(raw);
  const literal = splitLiteral(isAbsolute ? new URL(raw).pathname : raw);
  if (literal) {
    return { raw, form: isAbsolute ? 'absolute' : 'relative', ...literal };
  }

  return { raw, form: 'unknown' };
}

/**
 * Resolves a subject/patient reference to a local Patient id.
 *
 * Returns undefined when the reference is absent, points at a non-Patient
 * resource, or is logical-only. Callers record that as a data-quality issue
 * rather than guessing.
 */
export function resolvePatientId(value: Json): string | undefined {
  const reference = parseReference(value);
  if (!reference?.id) return undefined;
  // `urn:uuid:` references carry no type; in a bulk export the subject element
  // is Patient-typed by definition, so accept them.
  if (reference.resourceType && reference.resourceType !== 'Patient') return undefined;
  return reference.id;
}

/** Resolves a reference to a local id when — and only when — it is literal. */
export function resolveLocalId(value: Json, expectedType?: string): string | undefined {
  const reference = parseReference(value);
  if (!reference?.id) return undefined;
  if (reference.form !== 'relative' && reference.form !== 'absolute' && reference.form !== 'urn-uuid') {
    return undefined;
  }
  if (expectedType && reference.resourceType && reference.resourceType !== expectedType) return undefined;
  return reference.id;
}
