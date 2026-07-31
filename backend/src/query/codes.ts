/**
 * The clinical code panel the snapshot reports on.
 *
 * Metrics are matched on LOINC **code**, never on display text. The display
 * string is a label chosen by whatever system produced the export and varies
 * between them; the code is the identity. This dataset makes the difference
 * concrete: `39156-5` "Body mass index (BMI) [Ratio]" and `59576-9` "Body mass
 * index (BMI) [Percentile] Per age and sex" both have "Body mass index" in the
 * display, but only the first is a BMI value — the second is a paediatric
 * percentile on a 0–100 scale. A substring match on the label would read a
 * percentile as a BMI, which is exactly the mistake Part C's `BMI >= 40`
 * threshold cannot survive.
 */
import type { ObservationMetric } from './dto.js';

export const LOINC = 'http://loinc.org';

export interface MetricDefinition {
  metric: ObservationMetric;
  label: string;
  /** LOINC codes that count as this metric. */
  codes: string[];
  /** Shown when the patient has no reading, so the gap names how it was sought. */
  absentNote: string;
}

/**
 * Ordered as a reviewer reads them: the two the bariatric policy in Part C
 * turns on, then the comorbidity marker.
 *
 * Body weight and height are deliberately not here. BMI is recorded directly in
 * this export, so the panel shows the measurement the policy is written against
 * rather than the two inputs a reader would have to combine themselves. They
 * remain queryable and appear on the timeline; they are just not headline
 * numbers on a coverage decision.
 */
export const METRIC_PANEL: readonly MetricDefinition[] = [
  {
    metric: 'bmi',
    label: 'BMI',
    codes: ['39156-5'],
    absentNote: 'No Observation with LOINC 39156-5 (BMI) recorded for this patient.',
  },
  {
    metric: 'bloodPressure',
    label: 'Blood pressure',
    codes: ['85354-9'],
    absentNote: 'No Observation with LOINC 85354-9 (blood pressure panel) recorded for this patient.',
  },
  {
    metric: 'hba1c',
    label: 'HbA1c',
    codes: ['4548-4'],
    absentNote: 'No Observation with LOINC 4548-4 (HbA1c) recorded for this patient.',
  },
] as const;

/** Every LOINC code in the panel, for the single query that fetches them all. */
export const PANEL_CODES: readonly string[] = METRIC_PANEL.flatMap((entry) => entry.codes);

/** Reverse index: LOINC code -> the metric it belongs to. */
export const METRIC_BY_CODE: ReadonlyMap<string, MetricDefinition> = new Map(
  METRIC_PANEL.flatMap((entry) => entry.codes.map((code) => [code, entry] as const)),
);
