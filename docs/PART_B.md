# Part B — Frontend

Brief: [`../ASSESSMENT.md`](../ASSESSMENT.md) · Part A: [`PART_A.md`](PART_A.md)

Clinician-facing review UI over the Part A store: patient selector, clinical snapshot, timeline.
React 19 + Vite + TypeScript, against a read-only JSON API in the backend package.

---

## Running

```bash
pnpm install
pnpm run ingest      # only if .data/fhir.db does not exist (~45s)
pnpm run dev         # API :4000 + UI :5173
```

<http://localhost:5173>. Vite proxies `/api` to the backend, so the app uses relative URLs in both
dev and production.

| Command | Effect |
|---|---|
| `pnpm run dev` | API + UI |
| `pnpm run api` | API only — `--port`, `--db`, `--static` |
| `pnpm run ui` | Vite dev server only |
| `pnpm run build` | Bundle to `frontend/dist` |
| `pnpm run typecheck` / `pnpm run test` | Both packages |

Single process, once built: `pnpm run api -- --static ../frontend/dist`.

---

## Endpoints

| Route | Returns |
|---|---|
| `GET /api/meta` | Store counts, ingest timestamp, integrity checks |
| `GET /api/patients?q=&limit=&offset=` | Selector rows; `q` matches name or id |
| `GET /api/patients/:id/snapshot` | Demographics, age, conditions, procedures, metric panel |
| `GET /api/patients/:id/timeline?types=&order=&limit=&offset=` | Paged Observations + Procedures |
| `GET /api/resources/:type/:id` | One stored record, by citation |

Unknown patient → 404. Bad `limit`/`order`/`types` → 400 with the offending value.

## Layout

```
backend/src/
  query/        dto.ts codes.ts patients.ts snapshot.ts timeline.ts hydrate.ts
                fixture.ts snapshot.test.ts
  api/          routes.ts (pure) server.ts main.ts

frontend/src/
  lib/          api.ts (client + useAsync) format.ts (date precision)
  components/   primitives.tsx PatientSelector.tsx Snapshot.tsx Timeline.tsx
  App.tsx
```

---

## Design

**Separate API process, not Next.js server components.** The backend owns the normalized model and
has zero runtime dependencies. A JSON boundary keeps the query layer reusable by the Part C cohort
job and Part D grounding check, and keeps `node:sqlite` away from a bundler.

**No HTTP framework.** Five read-only endpoints. `routes.ts` is a pure function of
`(method, path, query) → (status, body)`, testable without a socket.

**Types cross the boundary, code does not.** The frontend imports from `@autonomy/backend/dto` with
`import type`. That package exports *only* `dto.ts`, which is pure type declarations with no
imports, and is a devDependency — nothing reachable from the browser bundle can pull in the store.

**Absence is a variant, not an optional field.**

```ts
type Age =
  | { kind: 'living';   years: number; asOf: string }
  | { kind: 'at-death'; years: number; diedOn: string }
  | { kind: 'unknown';  reason: 'no-birth-date' | 'died-before-birth-date' | 'birth-date-in-future' }

type KeyObservation =
  | { kind: 'recorded'; metric; label; codes; latest; count; earliest }
  | { kind: 'absent';   metric; label; codes; note: string }
```

A component cannot render either without handling the gap, and the arm names which gap it is. The
snapshot returns an entry for every metric in the panel whether or not the patient has a reading.

Consequences elsewhere:

- Conditions are partitioned active / resolved-or-remission / **no `clinicalStatus` at all**, not
  filtered to active. The third group is listed separately.
- Undated resources are counted and reported, not dropped. `Specimen` has no date on any
  type-appropriate element (66,850 rows dataset-wide); the timeline sorts them last and returns an
  `undated` count.
- Integrity state has three values: passed, failed, or **unverified** — an ingest run with
  `--no-verify` records no evidence, which is not a pass.

**Dates render at recorded precision.** `formatDate` switches on the stored precision: `2013`,
`Jul 2013`, `20 Jul 2013`. Partial dates are tagged. Formatting is string-based, never via `Date` —
`new Date('1961-02-11')` is UTC midnight and renders as the 10th west of Greenwich.

---

## Tests

`pnpm run test` — 20 tests (13 query layer, 7 inherited reader tests). Fixtures run raw FHIR through
the real pipeline (`normalizeResource` → real `StoreWriter` → real schema and indexes), so they test
what the ingest writes, not what the test wrote.

Covered: latest/count/earliest on the panel; partial-precision dates surviving the column
round-trip; the absent arm; code-not-text matching; BP from components; the three-way condition
partition; procedure ordering; unknown patient → `undefined`; `computeAge` across anniversaries,
death, missing and contradictory dates.

Not covered:

- No component rendering tests — the React tree is verified only by `tsc` and a production build.
- The UI has not been opened in a browser. Both processes start and the proxy serves correctly, but
  nothing has confirmed the rendered result.

---

## Requirements

| Requirement | Implementation |
|---|---|
| Select by name or ID | `GET /api/patients?q=` against `name_text` and `id` |
| Switching updates all views | Selected id is the only shared state; `PatientView` remounts on change; `useAsync` aborts in-flight requests |
| Age, sex | `Age` union; administrative gender and US Core birth sex as distinct facts |
| Active conditions | Snapshot panel, partitioned by `clinicalStatus` |
| Recent procedures | 10 most recent of the full count |
| Key observations | BMI, blood pressure, HbA1c |
| Timeline, chronological | Paged, both directions, per-type filters |
| Name, date, source resource ID per entry | Timeline row columns, plus observation value |
| Hierarchy > polish | One accent colour = interactive; colour otherwise reserved for data quality; tabular numerals; monospaced identifiers |
| Missing data explicit | Variant DTOs; single amber token with hover reason |
