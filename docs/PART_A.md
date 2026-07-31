# Part A — Data Ingestion

Brief: [`../ASSESSMENT.md`](../ASSESSMENT.md)

- **Source data:** `sample-bulk-fhir-datasets-1000-patients/` — 1.59 GB, 48 NDJSON files,
  1,441,877 resources, 1,132 patients
- **Runtime:** Node 24, TypeScript, `node:sqlite` (built in — no native deps, no ORM, no build step)
- **Package manager:** pnpm

Every measurement here is taken on the full export.

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

# Where the time goes within a run — 250 MB sample, ~10s
pnpm exec tsx src/cli.ts bench

# ...and split the slowest stage further
pnpm exec tsx src/cli.ts bench --deep

# Compare whole configurations end to end — full runs, ~40s each
pnpm exec tsx src/cli.ts bench --variants legacy@1,1

pnpm test
pnpm run typecheck
```

`package.json` has `pnpm run ingest` / `bench` shortcuts, but pass flags through the
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
| `--sample-mb N` | `250` | stage-breakdown mode only |
| `--deep` | off | stage-breakdown mode: also split the slowest stage |
| `--variants` | — | `[legacy@]workers`, comma-separated — e.g. `legacy@1,1` or `1,8` |

### Layout

```
backend/src/
  cli.ts                 ingest | bench
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
  bench/profile.ts       stage breakdown + store split
```

---

## 1. Architecture

```
                                    pnpm exec tsx src/cli.ts <command>
                                                    │
                    ┌───────────────────────────┴───────────────────────────┐
                    │                                                       │
                 ingest                                                   bench
                    │                                                       │
                    │                        bench/profile.ts — no flags: 5 sampled passes, each doing
                    │                        strictly more work; adjacent passes subtracted to
                    │                        attribute time to a stage.  --variants: full ingest
                    │                        once per configuration, totals compared.
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
│                    in-process sequential loop        worker pool (see below)                                  │
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
│        │   cases apart and loses any line beginning exactly on a boundary.                               │
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

### Parallel execution (`--workers N`)

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
                                                          └───────────────────┘
```

---

## 2. Performance

**Ingest went from 63.06s to 44.27s — 1.42x faster** on the full 1.59 GB export, single-threaded.
Same resource counts before and after.

### What I measured first

`bench` with no flags splits a run into stages and times each one. Writing to SQLite took 55.7% of
the time. Parsing the JSON took 13.6%.

So the problem was not how fast the files were read. It was how much was being written.

### What was wrong

Every FHIR resource carries one or more medical codes. A code is three pieces of text — the coding
system, the code itself, and a human label:

```
   http://snomed.info/sct        40055000     Chronic sinusitis (disorder)
   http://loinc.org              39156-5      Body mass index (BMI) [Ratio]
```

Those were stored one row per code, with all three strings written out on every row —
**1,369,627 rows**.

But the whole dataset only uses **1,323 different codes**. The same ~1,300 URLs and labels were
being written a million times over.

### What changed

Each distinct code is now stored once, in a small table of 1,323 rows. Every resource stores a
number pointing at its code instead of its own copy of the text.

The codes could not simply become columns on the resource table, because a resource can have more
than one — 147,464 of them do.

### Result

Each phase, timed separately, on the full 1.59 GB export:

```
                                       before       after
   ──────────────────────────────────────────────────────────
   read, parse and write the data       30.17s      22.74s
   build the database indexes           27.36s      17.34s
   verify nothing was lost               5.48s       4.18s
   ──────────────────────────────────────────────────────────
   total                                63.06s      44.27s
```
