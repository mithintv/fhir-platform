import { describe, expect, it } from 'vitest';
import { getClinicalSnapshot } from './snapshot.js';
import { computeAge } from './patients.js';
import { buildFixtureStore, condition, observation, patient, procedure } from './fixture.js';
import type { KeyObservation } from './dto.js';
import type { NormalizedPatient } from '../model/types.js';

/** Pulls one metric out of the panel, failing loudly if the panel dropped it. */
function metric(panel: KeyObservation[], name: string): KeyObservation {
  const found = panel.find((entry) => entry.metric === name);
  if (!found) throw new Error(`panel is missing the ${name} metric entirely`);
  return found;
}

describe('key observation panel', () => {
  it('reports the latest reading, the count, and the earliest date', () => {
    const db = buildFixtureStore([
      patient(),
      observation('o1', '39156-5', '2013-05-02T10:00:00Z', { value: 31.2, unit: 'kg/m2' }),
      observation('o2', '39156-5', '2019-08-11T10:00:00Z', { value: 36.4, unit: 'kg/m2' }),
      observation('o3', '39156-5', '2022-06-23T10:00:00Z', { value: 41.7, unit: 'kg/m2' }),
    ]);

    const snapshot = getClinicalSnapshot(db, 'p1');
    const bmi = metric(snapshot!.keyObservations, 'bmi');

    expect(bmi.kind).toBe('recorded');
    if (bmi.kind !== 'recorded') return;

    expect(bmi.latest.numeric).toBe(41.7);
    expect(bmi.latest.value).toBe('41.7 kg/m2');
    expect(bmi.latest.ref).toBe('Observation/o3');
    expect(bmi.count).toBe(3);
    // The regression this test exists for: `earliest` is re-parsed from the
    // `effective_value` column rather than read off a hydrated record, so it
    // must still agree with the oldest reading's own date.
    expect(bmi.earliest?.value).toBe('2013-05-02T10:00:00Z');
    expect(bmi.earliest?.precision).toBe('time');
  });

  it('preserves partial date precision on the earliest reading', () => {
    const db = buildFixtureStore([
      patient(),
      observation('o1', '39156-5', '2013', { value: 31.2, unit: 'kg/m2' }),
      observation('o2', '39156-5', '2022-06-23T10:00:00Z', { value: 41.7, unit: 'kg/m2' }),
    ]);

    const bmi = metric(getClinicalSnapshot(db, 'p1')!.keyObservations, 'bmi');
    if (bmi.kind !== 'recorded') throw new Error('expected a recorded BMI');

    // A year-precision date must survive the column round-trip as a year, not
    // silently become 1 January.
    expect(bmi.earliest).toEqual({
      value: '2013',
      sortKey: Date.parse('2013-01-01T00:00:00Z'),
      precision: 'year',
    });
  });

  it('returns an absent entry, with a reason, for a metric never recorded', () => {
    const db = buildFixtureStore([patient()]);
    const hba1c = metric(getClinicalSnapshot(db, 'p1')!.keyObservations, 'hba1c');

    expect(hba1c.kind).toBe('absent');
    if (hba1c.kind !== 'absent') return;
    expect(hba1c.note).toContain('4548-4');
  });

  it('always returns every metric in the panel, present or not', () => {
    const db = buildFixtureStore([patient()]);
    const panel = getClinicalSnapshot(db, 'p1')!.keyObservations;

    expect(panel.map((entry) => entry.metric)).toEqual(['bmi', 'bloodPressure', 'hba1c']);
    expect(panel.every((entry) => entry.kind === 'absent')).toBe(true);
  });

  it('matches on LOINC code, not display text', () => {
    // 59576-9 is a BMI *percentile* on a 0-100 scale. Its display contains
    // "Body mass index", so any substring match on the label would read this
    // 82nd-percentile value as a BMI of 82.
    const db = buildFixtureStore([
      patient(),
      observation('o1', '59576-9', '2022-06-23T10:00:00Z', { value: 82, unit: '%' }, {
        code: {
          coding: [{ system: 'http://loinc.org', code: '59576-9' }],
          text: 'Body mass index (BMI) [Percentile] Per age and sex',
        },
      }),
    ]);

    expect(metric(getClinicalSnapshot(db, 'p1')!.keyObservations, 'bmi').kind).toBe('absent');
  });

  it('renders a blood pressure panel from its components', () => {
    const db = buildFixtureStore([
      patient(),
      observation('bp1', '85354-9', '2022-06-23T10:00:00Z', undefined, {
        component: [
          {
            code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }], text: 'Systolic Blood Pressure' },
            valueQuantity: { value: 148, unit: 'mm[Hg]' },
          },
          {
            code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }], text: 'Diastolic Blood Pressure' },
            valueQuantity: { value: 94, unit: 'mm[Hg]' },
          },
        ],
      }),
    ]);

    const bp = metric(getClinicalSnapshot(db, 'p1')!.keyObservations, 'bloodPressure');
    if (bp.kind !== 'recorded') throw new Error('expected a recorded blood pressure');

    // Without the component fallback this reads as "no value" — the panel
    // observation itself carries no valueQuantity.
    expect(bp.latest.value).toBe('148/94 mm[Hg]');
    expect(bp.latest.parts).toHaveLength(2);
  });
});

describe('conditions', () => {
  it('separates active, inactive and undetermined rather than filtering', () => {
    const db = buildFixtureStore([
      patient(),
      condition('c1', 'Hypertension', 'active', '2015-01-01'),
      condition('c2', 'Viral sinusitis', 'resolved', '2016-01-01'),
      condition('c3', 'Type 2 diabetes', 'active', '2018-01-01'),
      // No clinicalStatus at all: the record never said, which is neither
      // active nor resolved.
      condition('c4', 'Chronic pain', undefined, '2019-01-01'),
    ]);

    const snapshot = getClinicalSnapshot(db, 'p1')!;

    expect(snapshot.activeConditions.map((entry) => entry.display)).toEqual([
      'Type 2 diabetes',
      'Hypertension',
    ]);
    expect(snapshot.inactiveConditionCount).toBe(1);
    expect(snapshot.undeterminedConditions.map((entry) => entry.display)).toEqual(['Chronic pain']);
  });
});

describe('procedures', () => {
  it('lists the most recent first and reports the full count', () => {
    const db = buildFixtureStore([
      patient(),
      procedure('pr1', 'Colonoscopy', '2011-01-01'),
      procedure('pr2', 'Appendectomy', '2020-05-05'),
      procedure('pr3', 'Sputum examination', '2015-07-07'),
    ]);

    const snapshot = getClinicalSnapshot(db, 'p1')!;
    expect(snapshot.recentProcedures.map((entry) => entry.display)).toEqual([
      'Appendectomy',
      'Sputum examination',
      'Colonoscopy',
    ]);
    expect(snapshot.procedureCount).toBe(3);
  });
});

describe('unknown patients', () => {
  it('returns undefined rather than an empty snapshot', () => {
    const db = buildFixtureStore([patient()]);
    expect(getClinicalSnapshot(db, 'no-such-patient')).toBeUndefined();
  });
});

describe('computeAge', () => {
  const at = (iso: string): Date => new Date(iso);

  it('counts whole years to the anniversary, not by dividing days', () => {
    const record = {
      birthDate: { value: '1970-03-15', sortKey: Date.parse('1970-03-15T00:00:00Z'), precision: 'day' },
    } as NormalizedPatient;

    expect(computeAge(record, at('2020-03-14T00:00:00Z'))).toEqual({
      kind: 'living',
      years: 49,
      asOf: '2020-03-14',
    });
    expect(computeAge(record, at('2020-03-15T00:00:00Z'))).toMatchObject({ years: 50 });
  });

  it('computes a deceased patient age at death, not today', () => {
    const record = {
      birthDate: { value: '1914-12-02', sortKey: Date.parse('1914-12-02T00:00:00Z'), precision: 'day' },
      deceasedDate: { value: '2010-04-16', sortKey: Date.parse('2010-04-16T00:00:00Z'), precision: 'day' },
    } as NormalizedPatient;

    expect(computeAge(record, at('2026-07-31T00:00:00Z'))).toEqual({
      kind: 'at-death',
      years: 95,
      diedOn: '2010-04-16',
    });
  });

  it('reports a missing birth date as unknown with a reason', () => {
    expect(computeAge({} as NormalizedPatient, at('2026-07-31T00:00:00Z'))).toEqual({
      kind: 'unknown',
      reason: 'no-birth-date',
    });
  });

  it('reports contradictory dates rather than a negative age', () => {
    const record = {
      birthDate: { value: '2010-01-01', sortKey: Date.parse('2010-01-01T00:00:00Z'), precision: 'day' },
      deceasedDate: { value: '2000-01-01', sortKey: Date.parse('2000-01-01T00:00:00Z'), precision: 'day' },
    } as NormalizedPatient;

    expect(computeAge(record, at('2026-07-31T00:00:00Z'))).toEqual({
      kind: 'unknown',
      reason: 'died-before-birth-date',
    });
  });
});
