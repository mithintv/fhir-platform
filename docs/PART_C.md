# Part C — Eligibility Logic & Cohort Report

Brief: [`../ASSESSMENT.md`](../ASSESSMENT.md) · Part D: [`PART_D.md`](PART_D.md)

Deterministic application of the simplified bariatric surgery policy to every patient in
the export, plus a cohort report over the results.

- **Policy:** BMI ≥ 40, **or** BMI ≥ 35 with at least one comorbidity; plus documented
  prior weight-loss attempts and a psychological evaluation
- **Cohort:** 1,132 patients (every patient with a `Patient` resource in the export)
- **Result:** 0 eligible · 893 not eligible (78.9%) · 239 unknown (21.1%)

Every number in this document comes from `pnpm cohort` against the full store.

---

## Running it

```bash
# The cohort report
pnpm cohort

# ...with worked examples of the patients closest to a determination
pnpm --filter @autonomy/backend exec tsx src/cli.ts cohort --examples 3

# ...as JSON, or scored against a different review date
pnpm --filter @autonomy/backend exec tsx src/cli.ts cohort --json
pnpm --filter @autonomy/backend exec tsx src/cli.ts cohort --as-of 2026-07-31

pnpm test
pnpm run typecheck
```

| Flag | Default | Notes |
|---|---|---|
| `--db PATH` | `../.data/fhir.db` | Store to read |
| `--as-of YYYY-MM-DD` | store's newest clinical date | Review date — see [The review date](#the-review-date) |
| `--json` | off | Emit the report as JSON instead of a table |
| `--examples N` | `0` | Also print N worked per-patient assessments |

### API

| Route | Returns |
|---|---|
| `GET /api/patients/:id/eligibility?asOf=` | `EligibilityAssessment` — the checklist for one patient |
| `GET /api/cohort/eligibility?asOf=` | `CohortReport` |

Both 400 on a malformed `asOf` rather than silently defaulting; the patient route 404s on
an unknown id rather than returning an empty assessment.

### Layout

```
backend/src/eligibility/
  policy.ts       the policy as data — thresholds, lookback, code sets
  evidence.ts     gathering (the only file that touches SQL)
  evaluate.ts     the evaluator — a pure function, no db, no clock
  cohort.ts       fold over every patient + the report
  dto.ts          wire types
frontend/src/components/
  Eligibility.tsx   per-patient verdict bar + review drawer
  CohortReport.tsx  the cohort view
```

### UI

The patient page carries a **verdict bar** — determination, outstanding-item count, and
the one sentence that produced it. The working lives behind it in a **right-hand,
full-height drawer**: the four requirements, each with its status, reasoning, cited
resource ids and any related-but-insufficient evidence, plus the policy parameters and the
"what would resolve this" list.

The split is on reading task, not on importance. The verdict is a glance and stays on the
page; the checklist is a read, and wants the full height of the window rather than a slot
between the snapshot and the timeline. The drawer is modal — Escape closes it, focus moves
in and back out, background scroll is locked — so a reviewer cannot change the selected
patient underneath it and end up reading one patient's requirements beside another's chart.

The cohort report is a separate top-level view, reachable from the masthead.

---

## 1. Architecture

### One evaluator, two fetch paths

The per-patient panel and the 1,132-patient report must never disagree. The only way to
guarantee that is for both to call the same function:

```
gather evidence  ──►  evaluateEligibility(evidence, policy, asOf)  ──►  assessment
   (SQL)                        (pure)
```

`evaluateEligibility` takes no database handle and no clock. Aggregate SQL would compute
the cohort report faster, and it would also be a second implementation of the policy that
could drift from the one on screen — a cohort report that disagrees with the patient it
summarises is worse than no cohort report. Instead the evidence for all 1,132 patients is
gathered in three queries and folded in memory.

A test asserts this directly: every assessment in the cohort result must `toEqual` the one
the single-patient route produces for that patient.

### The policy is data, not code

`policy.ts` holds the thresholds, the lookback window, and the code sets. It is the file a
clinical reviewer would argue with, and it is readable without reading the algorithm.
Part D consumes only an `EligibilityAssessment`; a model never gets to pick codes.

Everything matches on `(system, code)`, never on display text. This is not
fastidiousness — the export contains `39156-5` "Body mass index (BMI) [Ratio]" and
`59576-9` "Body mass index (BMI) [Percentile] Per age and sex". Both contain "body mass
index"; only the first is a BMI. A substring match on the label reads an 82nd-percentile
child as a BMI of 82 and clears them for surgery. There is a test for exactly this.

---

## 2. The logic

### Three-valued, and asymmetric on purpose

Each of the four requirements resolves to `met`, `not-met`, `unknown` or `not-applicable`,
and the determination is a fold over those. The rule that shapes everything:

> **Absence of evidence is not evidence of absence.**

- A recorded BMI of 28 *positively establishes* failure on both arms → **not eligible**.
- A patient with no coded comorbidity has not been shown to lack one. The chart is
  silent → **unknown**, never *not eligible*.

The consequence is deliberate and worth stating plainly: **only a BMI measurement can rule
a patient out.** Everything else can only fail to rule them in. In a prior-authorization
review a wrong `not eligible` denies care on the strength of a gap in the chart, so the
conservative direction is the one that refuses to infer.

### Requirements are assessed only when they can be answered

Comorbidity is evaluated **only** when BMI lands in the 35–40 band, because that is the
only case where the answer changes the outcome:

| BMI | Comorbidity requirement |
|---|---|
| ≥ 40 | `not-applicable` — not required |
| 35–40 | assessed: `met` or `unknown` |
| < 35 | `not-applicable` — the policy already fails on BMI |
| unknown | `not-applicable` — we cannot yet tell whether it is required |

In all four cases any comorbidity evidence found is still attached to the finding, so the
reviewer sees it. Without this rule the cohort's "top reasons for unknown" would be
dominated by comorbidity gaps belonging to patients whose actual problem is a missing BMI.

Documentation is likewise skipped only for patients already ruled out on BMI. When the
clinical arm is merely *unresolved*, both documents are still assessed — a reviewer
chasing records wants the complete list of what is missing in one pass.

### Evidence tiers: accepted vs related

Each documentation requirement has two code sets. `accepted` satisfies it. `related` is
clinically adjacent and explicitly insufficient — it can never promote a requirement to
`met`, but it is surfaced on the finding with a caveat.

This carries most of the clinical judgement in the whole exercise:

- **938 of 1,132 patients** have a `171207006` depression screening and **527** a PHQ-9.
  A PHQ-9 is a nine-question depression score, not the behavioural-health assessment a
  bariatric authorization requires. Accepting screens would mark most of the cohort as
  documented on evidence no reviewer would accept.
- RxNorm `897122` (3 mL liraglutide 6 mg/mL pen) is **genuinely ambiguous**: the same
  product code is Victoza for type 2 diabetes and Saxenda for weight management. It is
  surfaced with the ambiguity stated rather than silently counted either way.

"Eleven depression screens, none of which is an evaluation" is a different next action
from "nothing on file", and the panel says which.

### Withdrawn and resolved records

Conditions with `clinicalStatus` in `resolved`/`remission`/`inactive`, or
`verificationStatus` in `refuted`/`entered-in-error`, are dropped — not demoted to related
evidence. A Condition marked entered-in-error is not weak evidence of a comorbidity; it is
a statement that it was never recorded. A Condition with *no* `clinicalStatus` is kept:
the record never said it resolved, and dropping a coded diagnosis for a missing status
element would under-count comorbidity on exactly the incomplete charts this tool exists to
flag.

### The review date

The policy text states no recency requirement. This tool adds one — BMI must fall within
24 months of the review date — because a BMI from 1972 is a fact about a patient's past,
not a basis for authorizing surgery. It is a parameter precisely so a reviewer can see it
and change it.

**`asOf` defaults to the store's newest clinical date (2023-04-07), not the wall clock.**
This export is a static historical snapshot. Scored against today, every BMI in it is
stale and the report reads:

```
$ ... cohort --as-of 2026-07-31
eligible=0   not-eligible=0   unknown=1132
```

— 1,132 unknowns, all for `bmi-outside-lookback`. Every word of that is true and none of
it says anything about the patients; it describes the age of the file. Anchoring to the
data horizon asks the question the policy is actually about: *was this patient's BMI
current while the record was being kept?*

The choice is never hidden. `asOfSource` travels with every assessment, the UI and CLI
both label it, and `--as-of` / `?asOf=` override it.

---

## 3. The cohort report

```
Cohort: 1,132 patients with a Patient resource

  determination            patients    share
  eligible                     0     0.0%
  not-eligible               893    78.9%
  unknown                    239    21.1%
```

### Two breakdowns of `unknown`, not one

The brief asks for "top reasons for unknown status". Counted per reason the rows
**overlap** — a patient missing both documents appears twice, so shares exceed 100%:

| Reason | Patients | Of unknown | Of cohort |
|---|---|---|---|
| No evidence of prior weight-loss attempts | 238 | 99.6% | 21.0% |
| No psychological evaluation | 234 | 97.9% | 20.7% |
| BMI not recent enough | 179 | 74.9% | 15.8% |
| No BMI observation recorded | 43 | 18.0% | 3.8% |
| No qualifying comorbidity recorded | 7 | 2.9% | 0.6% |

That ranks how common each gap is, but not how close any patient is to a decision. So the
report also groups patients by their **exact set** of gaps — mutually exclusive, and a
one-gap row is a single document away from a determination:

| Gaps | Patients |
|---|---|
| `bmi-outside-lookback` + `no-weight-loss-documentation` + `no-psychological-evaluation` | 174 |
| `no-bmi-recorded` + `no-weight-loss-documentation` + `no-psychological-evaluation` | 43 |
| `no-weight-loss-documentation` + `no-psychological-evaluation` | 10 |
| `no-comorbidity-recorded` + `no-weight-loss-documentation` + `no-psychological-evaluation` | 6 |
| `bmi-outside-lookback` + `no-weight-loss-documentation` | 5 |
| `no-comorbidity-recorded` + `no-psychological-evaluation` | 1 |

The reasons are a closed union (`UnknownReason`), not free text — "top reasons" is only
aggregable if the vocabulary is fixed rather than a sentence that varies per patient.

### Why zero patients are eligible

This is the honest result, and it is a property of the export rather than of the patients.
The policy needs **both** documents:

| Accepted documentation code | Patients |
|---|---|
| `200619008` Comprehensive interview and evaluation | 22 |
| `79094001` Initial psychiatric interview with mental status and evaluation | 5 |
| `229095001` Exercise class (regime/therapy) | 4 |
| **patients with both requirements** | **0** |

The eligible set is empty before BMI is even consulted. Separately, only 10 patients clear
the clinical bar (4 at BMI ≥ 40, 6 in the band with a comorbidity).

This is Synthea data. It models diabetes, dentistry and depression screening in depth, and
does not model bariatric workups at all. The alternative — accepting PHQ-9 screens as
psychological evaluations and body-weight series as weight-loss attempts — would produce
a satisfying number of eligible patients on evidence no reviewer would accept, which is
precisely the false-confidence failure the brief is testing for.

The report says this itself rather than leaving it to be inferred: `codeCoverage` reports
what each policy code actually reaches in the store, `unmatchedPolicyCodes` names codes
that match nothing, and the UI prints an explicit note under a zero-eligible cohort.

### How far each arm reaches

```
patients with any BMI observation                       1,089
… with one inside the lookback window                     910
… meeting BMI >= 40 on its own                              4
… in the 35–40 band with a coded comorbidity                6
… in the 35–40 band with none coded                         7
patients with documented weight-loss attempts               4
patients with a psychological evaluation                   27
patients with both documentation requirements               0
deceased patients in the cohort                           132
```

These reconcile exactly: 1,132 − 1,089 = 43 with no BMI; 1,089 − 910 = 179 stale;
910 − (4 + 6 + 7) = 893 not eligible; 179 + 43 + 4 + 6 + 7 = 239 unknown.

### Deliberately narrow code sets

Every code in the accepted sets was verified against this export, and no code was included
that could not be verified. A production deployment would extend them considerably —
dietician referrals, supervised weight-management programme enrolments, anti-obesity
pharmacotherapy (orlistat, phentermine/topiramate, naltrexone-bupropion, semaglutide
2.4 mg), formal behavioural-health evaluations. Inventing plausible-looking codes for
concepts this dataset does not contain would make the code set look more authoritative
than it is. `PolicyCodeCoverage` makes the narrowness measurable rather than assumed.

Three codes present in the export are **deliberately excluded** from the comorbidity set:
`714628002` Prediabetes (not type 2 diabetes), and `162864005` / `408512008` (BMI 30+ /
BMI 40+ obesity findings — the obesity itself, which would make the comorbidity arm
circular with the BMI arm).

---

## 4. Performance

| | |
|---|---|
| Cohort report, cold | **1.8 s** for 1,132 patients over 1.44M resources |
| Cohort report, cached | 0.9 ms |
| Single patient | ~30 ms |

Three things carry this.

**The two fetch paths drive from opposite ends, and it matters.** For the cohort there is
no patient to start from, so the read leads with `resource_coding.coding_id` — the
policy's ~35 codings select ~46,000 of 1.44M resources. Reusing that shape for a single
patient with `AND r.patient_id = ?` appended looks equivalent and is not: SQLite still
leads with `coding_id`, walks all 46,000 matches, fetches each `resource` row to test its
`patient_id`, and discards all but a handful — a whole-store scan to answer a question
about one patient (measured: 150 ms warm, 1.4 s cold, and no cheaper as the store grows).
Materializing the patient's own resources first makes the driving set tens of rows. This
is the same trap documented at length in `query/snapshot.ts`.

**JSON blobs are only read where they are needed.** Comorbidity decisions need a
Condition's `clinicalStatus`, which lives in the JSON record and not a column — but the
psychological-evaluation related set alone matches ~19,000 Procedures and Observations.
The cohort read takes `json` under a `CASE WHEN resource_type = 'Condition'`; the patient
read fetches it separately by primary key. Everything else is decided from the `status`
column.

**Per-code coverage counts are folded into the same pass.** Asking them as a separate
`GROUP BY` doubled the report's wall clock (1.8 s → 3.8 s) for numbers the scan had
already touched.

The report cache is a `WeakMap` keyed by the connection *and* the review date. The store
is written once by the ingest and opened read-only by everything else, so a report cannot
go stale while the process runs — a cache with no invalidation problem rather than one
whose invalidation was skipped. Keying on the connection matters because the tests build a
fresh in-memory store per case.

---

## 5. Data-quality notes

- **1,143 subject ids** are referenced by resources (81,836 of them) but have no `Patient`
  resource in the export. They are outside the cohort, and the report says so rather than
  letting the reader assume 1,132 is the whole population.
- **132 of 1,132 patients are deceased.** They are assessed like any other — the policy
  says nothing about it — but the count is reported as context for the 239 unknowns.
- **179 patients' most recent BMI predates the lookback window**, some by decades (the
  oldest latest-BMI is 1972). These are `unknown`, not `not eligible`: a 1972 measurement
  cannot rule a patient in *or* out today.

---

## 6. Testing

27 tests in `backend/src/eligibility/eligibility.test.ts`, all running through the real
ingest pipeline (`buildFixtureStore` normalizes raw FHIR with the production normalizer,
writer and schema) and then the real gather + evaluate path. Hand-building a
`PatientEvidence` would prove the evaluator folds statuses correctly while saying nothing
about whether the code sets match what the normalizer actually writes — and every
interesting failure in this layer lives at that seam.

Coverage includes: each BMI band and the sole/band threshold split; missing, stale,
undated, valueless and percentile-coded BMIs; comorbidity matched by code and *not* by
display text; resolved and refuted conditions; entered-in-error documentation; related
evidence never promoting a requirement; the liraglutide ambiguity; `asOf` resolution,
month-end clamping in the lookback arithmetic, and rejection of a malformed date; cohort
totals, percentages, both unknown breakdowns; and the cohort-vs-patient agreement check.

---

## 7. Known gaps

- **No recency requirement on the documentation.** Real policies want a psychological
  evaluation within 6–12 months. The policy text imposes none and inventing one would
  change outcomes, so the evidence dates are shown and the reviewer judges. Stated here
  rather than left as a silent assumption.
- **The UI was compile- and build-verified but not visually reviewed** in this session —
  no browser was available. The API routes behind it were exercised directly.
- **`not eligible` can only be reached via BMI.** This is the deliberate asymmetry
  described above, not an oversight, but it does mean a patient with a recent BMI of 36
  and a genuinely empty comorbidity history sits in `unknown` forever rather than being
  cleared off the queue. A production system would want a reviewer-attestable "comorbidity
  history reviewed, none present" input to close that loop — which is a workflow feature,
  not a logic change.
