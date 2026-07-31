/**
 * Turning stored rows back into wire DTOs.
 *
 * Every read goes the same way: filter and order on the indexed columns, then
 * hydrate the record from the `json` blob. The blob is the full normalized
 * record, so nothing is lost to the column projection — the columns exist to
 * make the query fast, not to be the model.
 *
 * The value renderers here are the single place a clinical value becomes a
 * string. Blood pressure is the reason they are not one-liners: its numbers
 * live in `component[]`, not `valueQuantity`, so a naive renderer shows a
 * blood-pressure reading as having no value at all.
 */
import type {
  ConditionEntry,
  DateInfo,
  ObservationReading,
  ProcedureEntry,
  TimelineEntry,
  TimelineResourceType,
} from './dto.js';
import type {
  NormalizedCondition,
  NormalizedDate,
  NormalizedObservation,
  NormalizedProcedure,
  NormalizedResource,
  ObservationValue,
} from '../model/types.js';

/** Widens a normalized date to the wire shape, or `null` when there was none. */
export function toDateInfo(date: NormalizedDate | undefined): DateInfo | null {
  return date ? { value: date.value, sortKey: date.sortKey, precision: date.precision } : null;
}

/** Codings, flattened for display. Always an array, possibly empty. */
export function toCodings(
  resource: Pick<NormalizedResource, 'code'>,
): { system?: string; code?: string; display?: string }[] {
  return resource.code?.codings ?? [];
}

/**
 * Parses a stored `json` column.
 *
 * A row that fails to parse is a store-level defect, not user input, so it is
 * surfaced rather than swallowed — a silently dropped row would show up as a
 * patient having fewer procedures than they do.
 */
export function parseRecord<T extends NormalizedResource>(json: string, ref: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (cause) {
    throw new Error(`Stored record for ${ref} is not valid JSON`, { cause });
  }
}

/**
 * Renders a scalar `value[x]` for display.
 *
 * Returns `null` — not an empty string — when the value cannot be reduced to
 * one line, so callers can distinguish "no value" from "value rendered blank".
 */
export function renderValue(value: ObservationValue | undefined): string | null {
  if (!value) return null;
  switch (value.kind) {
    case 'quantity': {
      if (value.value === undefined) return null;
      const comparator = value.comparator ? `${value.comparator} ` : '';
      return `${comparator}${value.value}${value.unit ? ` ${value.unit}` : ''}`;
    }
    case 'integer':
      return String(value.value);
    case 'codeable':
      return value.concept.text ?? null;
    case 'string':
      return value.value;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'ratio': {
      if (value.numerator === undefined || value.denominator === undefined) return null;
      return `${value.numerator}/${value.denominator}${value.unit ? ` ${value.unit}` : ''}`;
    }
    case 'range': {
      const low = value.low ?? '?';
      const high = value.high ?? '?';
      return `${low}–${high}${value.unit ? ` ${value.unit}` : ''}`;
    }
    case 'datetime':
      return value.value;
    case 'period':
      return `${value.start ?? '?'} → ${value.end ?? '?'}`;
    case 'unsupported':
      // Deliberately visible: the source recorded a value we cannot render, and
      // that is a different fact from the source recording nothing.
      return `(unrendered ${value.element})`;
  }
}

/**
 * Renders an observation's components, e.g. the two halves of a blood pressure.
 *
 * Component labels are shortened where the LOINC display is long and the
 * context already carries the meaning ("Systolic Blood Pressure" inside a blood
 * pressure panel row).
 */
export function renderComponents(
  observation: Pick<NormalizedObservation, 'components'>,
): { label: string; value: string }[] {
  const parts: { label: string; value: string }[] = [];
  for (const component of observation.components ?? []) {
    const rendered = renderValue(component.value);
    if (rendered === null) continue;
    parts.push({ label: component.code?.text ?? 'Unlabelled component', value: rendered });
  }
  return parts;
}

/**
 * The one-line value for an observation: its own `value[x]` if it has one,
 * otherwise its components joined.
 *
 * Blood pressure is stored as a panel with no top-level value, so without the
 * component fallback the busiest vital sign in the dataset renders as blank.
 */
export function renderObservationValue(observation: NormalizedObservation): string | null {
  const scalar = renderValue(observation.value);
  if (scalar !== null) return scalar;

  const parts = renderComponents(observation);
  if (parts.length === 0) return null;

  const systolic = parts.find((part) => /systolic/i.test(part.label));
  const diastolic = parts.find((part) => /diastolic/i.test(part.label));
  if (systolic && diastolic) {
    // "141 mm[Hg] / 92 mm[Hg]" is noise; the unit is shared, so state it once.
    const unit = sharedUnitSuffix(systolic.value, diastolic.value);
    if (unit) {
      return `${stripUnit(systolic.value, unit)}/${stripUnit(diastolic.value, unit)} ${unit}`;
    }
    return `${systolic.value} / ${diastolic.value}`;
  }

  return parts.map((part) => `${part.label}: ${part.value}`).join(', ');
}

/** The unit shared by two rendered quantities, when they agree on one. */
function sharedUnitSuffix(left: string, right: string): string | null {
  const leftUnit = left.split(' ').slice(1).join(' ');
  const rightUnit = right.split(' ').slice(1).join(' ');
  return leftUnit.length > 0 && leftUnit === rightUnit ? leftUnit : null;
}

function stripUnit(rendered: string, unit: string): string {
  return rendered.slice(0, rendered.length - unit.length).trim();
}

/** Reads FHIR's explicit "value is absent because…" marker, if present. */
function dataAbsentReason(observation: NormalizedObservation): string | null {
  return observation.dataAbsentReason ?? null;
}

/** An observation as one reading of a key metric. */
export function toReading(observation: NormalizedObservation): ObservationReading {
  const scalar = observation.value;
  return {
    ref: observation.ref,
    id: observation.id,
    date: toDateInfo(observation.effective),
    value: renderObservationValue(observation),
    numeric:
      scalar && (scalar.kind === 'quantity' || scalar.kind === 'integer')
        ? (scalar.value ?? null)
        : null,
    unit: scalar && scalar.kind === 'quantity' ? (scalar.unit ?? null) : null,
    parts: renderComponents(observation),
    dataAbsentReason: dataAbsentReason(observation),
  };
}

export function toConditionEntry(condition: NormalizedCondition): ConditionEntry {
  return {
    ref: condition.ref,
    id: condition.id,
    display: condition.code?.text ?? null,
    clinicalStatus: condition.clinicalStatus ?? null,
    verificationStatus: condition.verificationStatus ?? null,
    onset: toDateInfo(condition.onset ?? condition.effective),
    recorded: toDateInfo(condition.recordedDate),
    codings: toCodings(condition),
  };
}

export function toProcedureEntry(procedure: NormalizedProcedure): ProcedureEntry {
  return {
    ref: procedure.ref,
    id: procedure.id,
    display: procedure.code?.text ?? null,
    status: procedure.status ?? null,
    performed: toDateInfo(procedure.performedStart ?? procedure.effective),
    codings: toCodings(procedure),
  };
}

/**
 * A stored record as a timeline row.
 *
 * `display` is `null` rather than a placeholder string when the resource has no
 * code, so the UI decides how to say "no name recorded" — the API should not
 * bake a human-facing phrase into the data.
 */
export function toTimelineEntry(
  record: NormalizedResource,
  resourceType: TimelineResourceType,
): TimelineEntry {
  const value =
    resourceType === 'Observation'
      ? renderObservationValue(record as NormalizedObservation)
      : null;

  return {
    ref: record.ref,
    id: record.id,
    resourceType,
    display: record.code?.text ?? null,
    date: toDateInfo(record.effective),
    status: record.status ?? null,
    value,
    category: record.categories?.[0]?.text ?? null,
    codings: toCodings(record),
  };
}
