/**
 * CodeableConcept / Coding normalization and value extraction.
 */
import type { NormalizedCoding, NormalizedConcept, ObservationValue } from '../model/types.js';
import { bool, compact, num, objArr, path, str } from './safe.js';
import type { Json } from './safe.js';

/**
 * Normalizes a single `Coding`. A coding with no system, code or display is
 * indistinguishable from an empty element, so it becomes `undefined`.
 */
export function parseCoding(value: Json): NormalizedCoding | undefined {
  const system = str(path(value, 'system'));
  const code = str(path(value, 'code'));
  const display = str(path(value, 'display'));
  if (!system && !code && !display) return undefined;
  return compact({ system, code, display });
}

/**
 * Normalizes a CodeableConcept. Duplicate codings (this dataset repeats them in
 * `meta.profile` style arrays) are collapsed on system+code.
 */
export function parseConcept(value: Json): NormalizedConcept | undefined {
  const codings: NormalizedCoding[] = [];
  const seen = new Set<string>();
  for (const entry of objArr(path(value, 'coding'))) {
    const coding = parseCoding(entry);
    if (!coding) continue;
    const key = `${coding.system ?? ''}|${coding.code ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    codings.push(coding);
  }

  const text = str(path(value, 'text')) ?? codings.find((c) => c.display)?.display ?? codings[0]?.code;
  if (!text && codings.length === 0) return undefined;
  return compact({ text, codings });
}

/**
 * Reads a code element that FHIR declares as either 0..1 or 0..* depending on
 * the resource type — `Encounter.type` and `PractitionerRole.code` are arrays,
 * while `Condition.code` and `DocumentReference.type` are single objects.
 * Returns the first usable concept from either shape.
 */
export function firstConcept(value: Json): NormalizedConcept | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const concept = parseConcept(entry);
      if (concept) return concept;
    }
    return undefined;
  }
  return parseConcept(value);
}

/**
 * Normalizes a repeating CodeableConcept element (`category`, `reasonCode`, …).
 * Returns `undefined` rather than `[]` so `compact` can drop the field entirely.
 */
export function parseConcepts(value: Json): NormalizedConcept[] | undefined {
  const concepts = objArr(value)
    .map(parseConcept)
    .filter((concept): concept is NormalizedConcept => concept !== undefined);
  return concepts.length > 0 ? concepts : undefined;
}

/**
 * The `value[x]` choice element, normalized into a tagged union.
 *
 * Unrecognised `value*` elements become `{ kind: 'unsupported' }` rather than
 * being dropped, so a reviewer can see that a value existed but we could not
 * render it — silently discarding it would look identical to "no value".
 */
const VALUE_ELEMENTS = [
  'valueQuantity',
  'valueCodeableConcept',
  'valueString',
  'valueBoolean',
  'valueInteger',
  'valueRatio',
  'valueRange',
  'valueDateTime',
  'valuePeriod',
  'valueTime',
  'valueSampledData',
  'valueAttachment',
] as const;

/**
 * Reads whichever `value[x]` element the resource (or observation component)
 * carries, in the order declared above, and returns the first one present.
 */
export function parseValue(resource: Json): ObservationValue | undefined {
  for (const element of VALUE_ELEMENTS) {
    const raw = path(resource, element);
    if (raw === undefined || raw === null) continue;

    switch (element) {
      case 'valueQuantity':
        return compact({
          kind: 'quantity' as const,
          value: num(path(raw, 'value')),
          unit: str(path(raw, 'unit')) ?? str(path(raw, 'code')),
          system: str(path(raw, 'system')),
          code: str(path(raw, 'code')),
          comparator: str(path(raw, 'comparator')),
        });
      case 'valueCodeableConcept': {
        const concept = parseConcept(raw);
        return concept ? { kind: 'codeable', concept } : undefined;
      }
      case 'valueString': {
        const value = str(raw);
        return value ? { kind: 'string', value } : undefined;
      }
      case 'valueBoolean': {
        const value = bool(raw);
        return value === undefined ? undefined : { kind: 'boolean', value };
      }
      case 'valueInteger': {
        const value = num(raw);
        return value === undefined ? undefined : { kind: 'integer', value };
      }
      case 'valueRatio':
        return compact({
          kind: 'ratio' as const,
          numerator: num(path(raw, 'numerator', 'value')),
          denominator: num(path(raw, 'denominator', 'value')),
          unit: str(path(raw, 'numerator', 'unit')),
        });
      case 'valueRange':
        return compact({
          kind: 'range' as const,
          low: num(path(raw, 'low', 'value')),
          high: num(path(raw, 'high', 'value')),
          unit: str(path(raw, 'low', 'unit')) ?? str(path(raw, 'high', 'unit')),
        });
      case 'valueDateTime':
      case 'valueTime': {
        const value = str(raw);
        return value ? { kind: 'datetime', value } : undefined;
      }
      case 'valuePeriod':
        return compact({
          kind: 'period' as const,
          start: str(path(raw, 'start')),
          end: str(path(raw, 'end')),
        });
      default:
        return { kind: 'unsupported', element };
    }
  }
  return undefined;
}

/** Pulls a plain number out of a value, when the value is numeric. */
export function numericValue(value: ObservationValue | undefined): number | undefined {
  if (!value) return undefined;
  if (value.kind === 'quantity' || value.kind === 'integer') return value.value;
  return undefined;
}
