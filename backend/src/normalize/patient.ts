/**
 * Patient normalization, including the US Core extensions this dataset uses.
 */
import type { NormalizedHumanName, NormalizedPatient } from '../model/types.js';
import { parseConcept } from '../fhir/concept.js';
import { parseDate } from '../fhir/dates.js';
import { parseReference } from '../fhir/reference.js';
import { arr, bool, compact, objArr, path, str } from '../fhir/safe.js';
import type { Json, JsonObject } from '../fhir/safe.js';

const US_CORE_RACE = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-race';
const US_CORE_ETHNICITY = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-ethnicity';
const US_CORE_BIRTHSEX = 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-birthsex';

/** Reads a top-level extension by url. */
function findExtension(raw: JsonObject, url: string): JsonObject | undefined {
  return objArr(path(raw, 'extension')).find((extension) => str(path(extension, 'url')) === url);
}

/**
 * US Core race/ethnicity are nested extensions: prefer the human-readable
 * `text` sub-extension, fall back to the OMB category display.
 */
function readCategoryExtension(raw: JsonObject, url: string): string | undefined {
  const extension = findExtension(raw, url);
  if (!extension) return undefined;
  const nested = objArr(path(extension, 'extension'));
  const text = nested.find((entry) => str(path(entry, 'url')) === 'text');
  const omb = nested.find((entry) => str(path(entry, 'url')) === 'ombCategory');
  return (
    str(path(text, 'valueString')) ??
    str(path(omb, 'valueCoding', 'display')) ??
    str(path(omb, 'valueCoding', 'code'))
  );
}

/**
 * Normalizes a `HumanName`, synthesising `text` from the given/family parts
 * when the source did not supply it. A name with nothing displayable is dropped.
 */
function parseName(value: Json): NormalizedHumanName | undefined {
  const family = str(path(value, 'family'));
  const given = arr(path(value, 'given'))
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== undefined);
  const prefix = arr(path(value, 'prefix'))
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== undefined);
  const suffix = arr(path(value, 'suffix'))
    .map((entry) => str(entry))
    .filter((entry): entry is string => entry !== undefined);

  const text = str(path(value, 'text')) ?? [...given, family].filter(Boolean).join(' ');
  if (!text) return undefined;

  return compact({
    text,
    family,
    given: given.length > 0 ? given : undefined,
    prefix: prefix.length > 0 ? prefix : undefined,
    suffix: suffix.length > 0 ? suffix : undefined,
    use: str(path(value, 'use')),
  });
}

/** Prefers the `official` name, then the first usable one. */
function pickPrimaryName(names: NormalizedHumanName[]): NormalizedHumanName | undefined {
  return names.find((name) => name.use === 'official') ?? names.find((name) => name.use !== 'old') ?? names[0];
}

/**
 * Normalizes a Patient resource.
 *
 * Every name is kept (not just the primary one) because Part B's patient search
 * has to match on maiden and nickname entries too. Absent demographics are
 * recorded as issues rather than filled in, so a reviewer can tell "not stated"
 * apart from "not collected".
 */
export function normalizePatient(raw: JsonObject, id: string): NormalizedPatient {
  const issues: string[] = [];

  const names = objArr(path(raw, 'name'))
    .map(parseName)
    .filter((name): name is NormalizedHumanName => name !== undefined);
  if (names.length === 0) issues.push('missing-name');

  const birthDate = parseDate(path(raw, 'birthDate'));
  if (!birthDate) issues.push('missing-birth-date');

  const gender = str(path(raw, 'gender'));
  if (!gender) issues.push('missing-gender');

  const identifiers = objArr(path(raw, 'identifier'))
    .map((identifier) =>
      compact({
        system: str(path(identifier, 'system')),
        value: str(path(identifier, 'value')),
        type: str(path(identifier, 'type', 'text')) ?? str(path(identifier, 'type', 'coding', '0', 'code')),
      }),
    )
    .filter((identifier) => identifier.value !== undefined);

  const address = objArr(path(raw, 'address'))[0];

  const deceasedDate = parseDate(path(raw, 'deceasedDateTime'));
  const deceasedFlag = bool(path(raw, 'deceasedBoolean'));

  return compact({
    id,
    ref: `Patient/${id}`,
    name: pickPrimaryName(names),
    names,
    gender,
    birthDate,
    deceased: deceasedDate ? true : deceasedFlag,
    deceasedDate,
    maritalStatus: parseConcept(path(raw, 'maritalStatus')),
    birthSex: str(path(findExtension(raw, US_CORE_BIRTHSEX), 'valueCode')),
    race: readCategoryExtension(raw, US_CORE_RACE),
    ethnicity: readCategoryExtension(raw, US_CORE_ETHNICITY),
    language:
      str(path(raw, 'communication', '0', 'language', 'text')) ??
      str(path(raw, 'communication', '0', 'language', 'coding', '0', 'display')),
    address: address
      ? compact({
          line: arr(path(address, 'line'))
            .map((entry) => str(entry))
            .filter((entry): entry is string => entry !== undefined),
          city: str(path(address, 'city')),
          state: str(path(address, 'state')),
          postalCode: str(path(address, 'postalCode')),
          country: str(path(address, 'country')),
        })
      : undefined,
    identifiers,
    managingOrganization: parseReference(path(raw, 'managingOrganization')),
    issues: issues.length > 0 ? issues : undefined,
  });
}
