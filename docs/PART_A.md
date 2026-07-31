# Part A — Data Ingestion

Brief: [`../ASSESSMENT.md`](../ASSESSMENT.md)

- **Source data:** `sample-bulk-fhir-datasets-1000-patients/` — 1.59 GB, 48 NDJSON files,
  1,441,877 resources, 1,132 patients
- **Runtime:** Node 24, TypeScript, `node:sqlite` (built in — no native deps, no ORM, no build step)
- **Package manager:** pnpm

Everything here is implemented and has been run end to end; §6 states exactly what is and is not
proven. The measurements in §3 are the baseline that later optimizations are compared against.

---

## Running it

Needs Node 24+, pnpm, and the dataset unzipped in the repo root
([download](https://github.com/smart-on-fhir/sample-bulk-fhir-datasets/archive/refs/heads/1000-patients.zip)).

```bash
cd backend
pnpm install
```

All commands run from `backend/`:

```bash
# Full ingest into .data/fhir.db   (~45s single-threaded, includes integrity checks)
pnpm exec tsx src/cli.ts ingest

# Where the time goes — read-only sample, ~10s
pnpm exec tsx src/cli.ts profile

# Same ingest at 1 vs 8 workers, prints a speedup table
pnpm exec tsx src/cli.ts bench --list 1,8

# Data-quality report from an existing store
pnpm exec tsx src/cli.ts stats

# Second-level breakdown of the store stage
pnpm exec tsx src/bench/store-profile.ts

pnpm test
pnpm run typecheck
```

`package.json` has `pnpm run ingest` / `profile` / `bench` shortcuts, but pass flags through the
`tsx` form above — pnpm's argument forwarding on run-scripts is fiddly.

| Flag | Default | Notes |
|---|---|---|
| `--source DIR` | `../sample-bulk-fhir-datasets-1000-patients` | Bulk export directory |
| `--db PATH` | `../.data/fhir.db` | Output store |
| `--workers N` | cores − 2, capped at 16 | `--workers 1` is the benchmark baseline |
| `--chunk-mb N` | `8` | Byte-range chunk size |
| `--batch N` | `25000` | Rows per transaction |
| `--types A,B` | all | Restrict to given FHIR resource types |
| `--no-notes` | off | Skip decoding base64 clinical notes |
| `--no-indexes` | off | Skip index creation (benchmark isolation only) |
| `--no-verify` | off | Skip integrity checks (saves a ~4s re-read pass) |
| `--quiet` | off | Suppress the progress line |
| `--sample-mb N` | `250` | `profile` only |
| `--list 1,4,8` | `1,<cores-2>` | `bench` only — worker counts to compare |

### Layout

```
backend/src/
  cli.ts                 ingest | profile | bench | stats
  model/types.ts         the normalized internal model
  fhir/                  safe field access, dates, references, CodeableConcept
  normalize/             per-resource-type normalizers + generic fallback
  ingest/
    discover.ts          file discovery + byte-range chunk planning
    reader.ts            boundary-aware NDJSON reader
    reader.test.ts       boundary tests — the invariant that matters most
    process.ts           the unit of work, shared by both execution modes
    run.ts               orchestrator + worker pool
    worker.ts            worker thread entry
    verify.ts            independent integrity checks
    stats.ts             data-quality counters
  store/
    schema.ts            tables, indexes, pragmas
    statements.ts        every INSERT + its parameter order, in one place
    writer.ts            batched writer, coding dictionary interning
    db.ts                connection helpers
  bench/                 stage profiler, store breakdown
```

---

## 1. Module and data flow

```
                                    pnpm exec tsx src/cli.ts <command>
                                                    │
        ┌────────────────────┬──────────────────────┴──────────────────┬─────────────────────────┐
        │                    │                                         │                         │
     ingest               profile                                    bench                     stats
        │                    │                                         │                         │
        │          bench/profile.ts       (5 passes, each doing        │              reads ingest_meta from
        │          bench/store-profile.ts  strictly more work;      runs ingest at        an existing store;
        │                                  subtract adjacent        several worker        prints data-quality
        │                                  passes to attribute      counts and             report
        │                                  time to a stage)         compares
        ▼
┌───────────────────────────────────────── ingest/run.ts ──────────────────────────────────────────────────┐
│                                                                                                           │
│   1.  discover.ts      readdir(sourceDir)  ──►  BulkFile[]      sorted largest-file-first, so the         │
│                                                                  long pole starts early and small files    │
│                                                                  backfill the tail                         │
│                                                                                                            │
│   2.  discover.ts      planChunks(files, 8 MB)  ──►  Chunk[]    { path, resourceType, start, end }         │
│                                                                  byte ranges *within* files, not whole     │
│                                                                  files — a 51 MB shard would otherwise     │
│                                                                  pin one worker while others idle          │
│                                                                                                            │
│   3.  store/db.ts      openDatabase({ fresh: true })                                                       │
│                        createTables()                            ◄── indexes deliberately NOT created yet  │
│                                                                                                            │
│   4.  dispatch ────────────────┬──────────────────────────────┐                                            │
│                                │                              │                                            │
│                       workers = 1                      workers = N                                         │
│                    in-process sequential loop        worker pool (see §2)                                  │
│                    (the benchmark baseline)                                                                │
│                                                                                                            │
│   5.  store/db.ts      createIndexes()                           ◄── after bulk load: maintaining 8 b-trees │
│                                                                      per row during a 1.4 M-row insert is   │
│                                                                      slower than sorting once at the end    │
│                                                                                                            │
│   6.  ingest/verify.ts countSourceLines() + verifyStore()        ◄── independent re-read: counts 0x0A    │
│                                                                       bytes directly, never touching the  │
│                                                                       chunk planner or reader, so it CAN  │
│                                                                       catch boundary bugs the in-run      │
│                                                                       counters cannot. 5.5s; --no-verify  │
│                                                                       skips it, bench disables it.        │
│                                                                                                            │
│   7.  store/db.ts      recordMeta(stats, timings, files, workers, verification)                            │
│                                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
┌──────────────────────────────────────── ingest/process.ts ───────────────────────────────────────────────┐
│  processChunk(chunk, writer, options, stats)  —  shared verbatim by both execution modes, so the          │
│                                                   benchmark compares parallelism and nothing else         │
│                                                                                                            │
│    reader.ts  ──►  onLine(buffer, start, end)                                                              │
│        │                                                                                                   │
│        │   Boundary rule: a chunk owns a line iff the line's FIRST byte is in [start, end).                │
│        │   A chunk starting mid-line discards that partial line (the previous chunk owns it) and           │
│        │   reads past `end` to finish the line it opened last. Every line is processed exactly once,       │
│        │   with zero coordination between workers. Split on the 0x0A byte before any UTF-8 decode —        │
│        │   a newline byte cannot appear inside a multi-byte sequence, so this is safe and avoids           │
│        │   decoding an 8 MB chunk into one giant string.                                                   │
│        │                                                                                                   │
│        │   Non-first chunks read from `start - 1`. That one extra byte answers "is `start` already a       │
│        │   line start?" without a second read: a newline there means the discard consumes only the         │
│        │   newline and the line at `start` survives. Reading from `start` alone cannot tell the two        │
│        │   cases apart and silently loses any line beginning exactly on a boundary — see §5.               │
│        ▼                                                                                                   │
│    JSON.parse(buffer.toString('utf8', start, end))  ──►  malformed?  count + sample + continue             │
│        │                                                  (one bad line must not abort a 1.6 GB run)       │
│        ▼                                                                                                   │
│    normalize/index.ts   normalizeResource(raw, typeHint, options, allowedTypes)                            │
│        │                                                                                                   │
│        │   resourceType inside the resource always wins over the filename hint — bulk exports mix          │
│        │   OperationOutcome rows into type files to report row-level export errors                         │
│        │                                                                                                   │
│        ├─ Patient ─────────────────►  normalize/patient.ts    names, US Core race / ethnicity /            │
│        │                                                       birthsex extensions, address, identifiers   │
│        │                                                                                                   │
│        └─ everything else ─────────►  normalize/envelope.ts   shared fields: id, ref, patientId,           │
│                                                                encounterId, status, code, categories,      │
│                                                                effective date + which element it came from │
│                                       + RESOURCE_NORMALIZERS[resourceType]                                 │
│                                           Observation  ── value[x], component[], dataAbsentReason,         │
│                                                            interpretation, referenceRange                  │
│                                           Condition    ── clinical/verification status, onset, abatement   │
│                                           Procedure    ── performed start/end, reasons, body sites         │
│                                           Encounter    ── class, types, period, reasons                    │
│                                           DocumentRef  ── decoded base64 clinical note text                │
│                                           MedicationRequest, AllergyIntolerance                            │
│                                       + generic envelope fallback for any unmapped type                    │
│                                                                                                            │
│        supporting primitives                                                                               │
│            fhir/safe.ts       every raw read goes through these — absent / null / wrong-JSON-type          │
│                               fields degrade to undefined instead of throwing                              │
│            fhir/dates.ts      FHIR dates are deliberately imprecise (`2013`, `2013-07`, `2013-07-20`).     │
│                               Keeps the original string, derives a separate sort key, records precision    │
│            fhir/reference.ts  five reference forms seen in this data → a local patient id, or an           │
│                               explicit "unresolvable" (never a guess)                                      │
│            fhir/concept.ts    CodeableConcept + the value[x] choice element as a tagged union              │
│        │                                                                                                   │
│        ▼                                                                                                   │
│    store/writer.ts   buffer rows, flush every 25,000 inside one transaction                                │
│                      (autocommit would fsync per row: ~1 k/sec vs ~1.8 M/sec — table stakes, not the        │
│                       optimization this exercise is about)                                                 │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
┌────────────────────────────────────────── .data/fhir.db ─────────────────────────────────────────────────┐
│                                                                                                            │
│   patient                  1,132 rows        demographics as columns + full record as JSON                 │
│   resource             1,440,745 rows        envelope as columns + full record as JSON  ◄── ~730 B avg     │
│   coding                   1,323 rows        DICTIONARY of distinct (system, code, display)                │
│   resource_coding      1,586,515 rows        ASSOCIATION resource -> coding, carrying `ordinal`            │
│   observation_component  283,913 rows        blood pressure lives in component[], not valueQuantity —      │
│                                               without this table a BP reading has no queryable number      │
│   ingest_meta                  6 rows        run stats, timings, verification, data-quality counters       │
│                                                                                                            │
│   A CodeableConcept is one-to-many over Codings — 147,464 resources here carry two — so a single code      │
│   column cannot represent it. But the export references only 1,323 distinct codings, so a flat side        │
│   table repeating the system URL and display string on every row stores the same few hundred strings a     │
│   million times over. Dictionary + association is the shape that fits both facts.                          │
│                                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Parallel execution topology (`--workers N`)

```
      MAIN THREAD                                                    EACH WORKER
      ───────────                                                    ───────────
      Chunk[] work queue                                             own DatabaseSync connection
                                                                     own StoreWriter (25 k batch)
      Pull, not push: a worker receives its next chunk               own IngestStats
      only when it reports the previous one done. With               messages handled strictly in order
      chunk sizes spanning a ~50× range, static round-robin          (node:sqlite is synchronous, so
      assignment would leave workers idle at the tail.                overlapping chunks in one worker
                                                                      gains nothing)
      ┌──────────────┐
      │              │   'chunk'   ────────────►   ┌────────────┐
      │              │                             │  worker 0  │ ───┐
      │              │   ◄────────  'chunk-done'   └────────────┘    │
      │              │                                              │
      │              │   'chunk'   ────────────►   ┌────────────┐    │    Normalized records never cross
      │   dispatch   │                             │  worker 1  │ ───┤    the thread boundary. Measured
      │              │   ◄────────  'chunk-done'   └────────────┘    │    structured-clone cost for this
      │              │                                              │    dataset: 9.6 s as object graphs
      │              │              ⋮                    ⋮          │    (6.6 s of it on the receiving
      │              │                                              │    thread alone) vs 0.9 s as strings.
      │              │   'finish'  ────────────►   ┌────────────┐    │    Each worker writes its own rows,
      │   merge      │                             │  worker N  │ ───┤    so that cost is simply not paid.
      │   stats      │   ◄────────  'finished'     └────────────┘    │
      └──────────────┘                                              │
                                                                    ▼
                                                          ┌───────────────────┐
                                                          │     fhir.db       │   WAL mode.
                                                          │                   │   Readers never block, but
                                                          │                   │   only ONE writer at a time —
                                                          └───────────────────┘   see §4.
```

---

## 3. Measured baseline

Full single-threaded run over the whole 1.59 GB export (`--workers 1`):

```
   phase                                   time      share    parallelizable?
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   load  (parse + normalize + write)      22.93s      52%     partly — writes serialize on one writer
   build indexes                          16.95s      38%     NO — serial single-threaded SQLite work
   verify (independent re-read)            4.24s      10%     optional (--no-verify)
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   total                                  44.18s              load throughput 71 MB/s

   Run-to-run variance is ~±1s (page-cache warmth); treat these as approximate.
```

Inside the load phase, from a 201 MB sampled profile (five passes, each doing strictly more work
than the last; adjacent passes subtracted to attribute time to a stage):

```
   stage        cumulative   attributable    share
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   read              0.14s          0.14s     3.5%   ▓
   decode            0.10s         -0.04s     ~0%    ·        within measurement noise
   parse             0.67s          0.58s    14.6%   ▓▓▓▓▓▓▓
   normalize         1.88s          1.21s    30.5%   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
   store             3.96s          2.08s    52.5%   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

Second-level breakdown of `store` (173,143 resources, 121 MB of JSON, avg 730 B/resource):

```
   JSON.stringify only ...............   342 ms
   insert resource rows (with blob) ..  1156 ms
   insert resource rows (no blob) ....   454 ms
   full writer (all 3 tables) ........  1590 ms
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   attributable to the JSON blob .....  1044 ms   →  66% of `store`
   attributable to side tables .......    91 ms   →   6% of `store`
```

### Store composition

2.45 GB of database from a 1.59 GB source — **~1.2 GB of it is the JSON blob column.**

```
   resource ...................  1,440,745 rows
   resource_coding ............  1,586,515 rows   (association; four narrow columns)
   observation_component ......    283,913 rows
   coding .....................      1,323 rows   (dictionary)
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   total ......................  3,313,628 rows  across 7 indexes  ->  16.95s of index build

   That is MORE rows than the original flat design (3,094,285) and still builds indexes 38% faster:
   the rows are integers and short ids rather than repeated URLs and display strings.
```

---

## 4. What the measurements say about the redesign

Two assumptions the design was built on turned out to be wrong, and each changed the plan.

**The write path was assumed to be a rounding error.** The expectation was that `JSON.parse` +
normalize would dominate and the database would cost ~8%, making worker parallelism the obvious
first optimization. Measured, `store` is **52.5%** of the load phase and parsing is 14.6%.

**Index building was never profiled at all** — the profiler only ever covered the load path. It is
**27.36s, 43% of total runtime**, serial single-threaded work over 3.09 M rows, and worker threads
do nothing for it whatsoever.

Together these cap parallelism hard. Even a perfect speedup on the load phase leaves the 27.36s
index build plus the serial portion of the writes, so **total speedup tops out near 1.4×** — not the
~7× a CPU-bound-parse assumption predicts, and not the 2.4× estimated before index cost was known.

### Two coding designs, both wrong, and what the data actually says

The first design gave every coding a row in a flat `resource_coding` table carrying
`(resource_id, resource_type, patient_id, system, code, display)`. It was justified in the schema
comment on the grounds that a Condition may carry SNOMED *and* ICD-10.

That table was then deleted, on the strength of this check:

```sql
SELECT count(*) FROM (
  SELECT resource_id FROM resource_coding
  WHERE resource_type = 'Condition'      -- <<< scoped to ONE type
  GROUP BY resource_id HAVING count(*) > 1
);   -- 0
```

The result was reported as "no resource in this export carries a second coding" and acted on.
**That was wrong.** Conditions are single-coded; other types are not:

```
   DiagnosticReport ......  73,356 of   143,953
   DocumentReference .....  68,533 of    68,533      every single one
   Observation ...........   5,575 of   648,136
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   TOTAL .................  147,464 of 1,440,745     10.2%
```

Deleting the table therefore lost code-first queryability on 147,464 second codings — a
DocumentReference typed as both "History and physical note" and "Evaluation + Plan note" could no
longer be found by its second code.

But the flat table was wrong too, for a reason visible in the same data: the entire export
references only **1,323 distinct codings**. Storing the system URL and display string on every one
of 1.37M rows writes the same few hundred strings a million times over.

Both facts together give the shape the model uses now — a `coding` dictionary plus a
`resource_coding` association carrying `ordinal`:

```
                         flat side table        dictionary + association
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   rows                       1,369,627              1,323  +  1,586,515
   per row                (uuid, type, uuid,        (int, short id, int, int)
                           URL, code, display)
   multi-coding                 stored                  stored, with order preserved
   distinct strings         ~1.37M copies            1,323 rows, referenced by id
```

### Measured effect

```
                        original      flat table       dictionary +
                                        deleted        association
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   load                     30.17s        22.27s          22.93s
   build indexes            27.36s        17.96s          16.95s
   verify                    5.48s         4.26s           4.24s
   total                    63.06s        44.56s          44.18s      ->  1.43x
   store size              2.59 GB       2.34 GB         2.45 GB
   code queryability          full          BROKEN            full
   ─────────────────────────────────────────────────────────────────────────────────────────────────────
   correctness: identical counts throughout, all four integrity checks PASS, 0 parse errors
```

The normalized model gets the full 1.43x speedup **and** full coding queryability. Deleting the
table outright was marginally faster and quietly lossy.

Worth noting against the parallelism plan: the Amdahl ceiling on worker threads was ~1.4x and needs
the entire worker-pool machinery. Reshaping one table achieved that on its own, and the two compose
— the load phase is now a larger fraction of a smaller total.

### Remaining candidates, ranked by measured payoff

**a. Shrink the JSON blob** — ~1.2 GB, and the largest single cost inside the load phase. Measured
precisely: `ref` is 5.0% of blob bytes and fully derivable from type + id; the `code` object is
12.1%, of which 9.5% is reconstructible from the columns beside it. So ~14.5% is removable without
loss — worth roughly 170 MB, not the "half the database" figure implied earlier.

**b. `page_size` PRAGMA** — at ~730 B average, rows likely exceed SQLite's inline threshold and
spill to overflow pages, costing an extra page write each. One line to test.

**c. Worker parallelism** — already implemented, still the smallest of the three.

---

## 5. Correctness

Two layers, because the first turned out to be insufficient.

**Line reconciliation** — `lines read = normalized + skipped + unparsable` — catches a normalization
path that returns without counting anything. But both sides derive from the *same* emission event
inside the reader, so a chunk-boundary bug makes both sides short and still reports `OK`. It is
structurally blind to the riskiest code in the ingest.

**Independent verification** (`ingest/verify.ts`, on by default) closes that gap by re-reading all
1.59 GB and counting `0x0A` bytes directly, never touching the chunk planner or the reader:

```
   [PASS] lines read vs. independent byte-level count   1,441,877 = 1,441,877
   [PASS] resource rows committed vs. normalized       1,440,745 = 1,440,745
   [PASS] patient rows committed vs. seen                  1,132 = 1,132
   [PASS] resource ids unique per type                 1,440,745 = 1,440,745
```

The last check matters for Part D: AI citations are grounded by resolving `ResourceType/id` back to
a stored record, which requires ids unique per type. A failed check sets a non-zero exit code.

### Bug 1 — the chunk reader dropped lines on exact boundaries

The chunk reader dropped any line whose first byte landed exactly on a chunk boundary. Chunk 1
stopped — the line began at its exclusive `end` — and chunk 2 discarded it as a partial line, which
it was not. At 8 MB chunks over ~1.1 KB lines that is roughly a 1-in-1100 chance per boundary, so a
full run had a coin-flip chance of silently losing a resource while reporting `OK`.

It was found by writing `src/ingest/reader.test.ts`, not by reading the code — the reader had been
read and described as correct twice beforehand. Four of seven tests failed on the first run; all
four traced to that single off-by-one. Fixed by reading one byte before `start` (§1).

Coverage now: every chunk size from 7 bytes upward, boundaries placed exactly on line starts, final
line without a trailing newline, CRLF endings, and a 500 KB line exceeding the read buffer.

---

### Bug 2 — 15% of resources had no queryable code

Every run printed `missing-code: 218,582` from the first ingest onward. It was reported as an
observation about the data — "15% of resources carry no code element" — rather than treated as
suspicious. It was a parser defect, and every one of those resources did carry a code:

| Type | Where its code actually is | Why it was missed |
|---|---|---|
| Encounter, EpisodeOfCare | `type` | it is `0..*`, and `parseConcept` reads `.coding` off the value — an array has none |
| PractitionerRole | `code` | same cardinality problem |
| MedicationRequest | `medicationCodeableConcept` | the envelope only looked at `code` and `type` |
| Immunization | `vaccineCode` | same |

`DocumentReference` worked only because its `type` happens to be `0..1`. Fixed with a per-type
`CODE_ELEMENTS` map (the same shape as the existing `EFFECTIVE_DATE_ELEMENTS`) plus a
`firstConcept()` that accepts either cardinality.

```
   missing-code   before: 218,582      after: 1,694      99.2% recovered
```

The 1,694 remaining are genuine: `Practitioner` has no code element in FHIR at all, and those
`Location` records carry no `type`.

Newly queryable as a result — data that was in the database but unreachable by code:

```
   RxNorm medications ..............  64,500 links
   Encounter / EpisodeOfCare types . ~133,700 links
   CVX vaccines ....................  17,109 links
   NUCC provider taxonomy ..........     847 links
```

The medications matter for Part C: the bariatric policy requires evidence of prior weight-loss
attempts, and a weight-loss drug prescription is exactly that.

**The pattern in both bugs.** Neither was found by reading the code — the reader had been read and
described as correct twice, and `missing-code: 218,582` was printed by every run for hours. One was
found by writing a test, the other by a question that forced a check against the raw data. Both had
been *reported as facts about the dataset* rather than suspected as defects.

---

## 6. Observed data quality

```
   missing-date ......   70,239    no usable date on any type-appropriate element
   missing-subject ...    3,389    all Location / Practitioner / Organization / PractitionerRole —
                                   resources that legitimately have no patient, flagged not dropped
   missing-code ......    1,694    Practitioner (no code element in FHIR) + Locations with no type
   parse errors ......        0
```
