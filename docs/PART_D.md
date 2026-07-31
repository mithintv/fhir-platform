# Part D — AI-Assisted Review

Brief: [`../ASSESSMENT.md`](../ASSESSMENT.md) · Part C: [`PART_C.md`](PART_C.md)

An AI Assist that explains a Part C determination to a reviewer, under the brief's four
constraints: everything cited or explicitly unknown, the deterministic outcome untouched,
every failure degraded safely, and no silent inference.

- **The model writes prose. It does not write facts.** The determination, every requirement
  status and every citation are copied from Part C and are *absent from the model's output
  schema*, so the determinism boundary is structural rather than an instruction.
- **Every claim is checked before it is shown.** Ten grounding rules; any failure discards
  the whole draft and shows Part C's own explanation, labelled with what went wrong.
- **Offline by default.** The shipped provider needs no key and no network; the live
  Anthropic path is one environment variable away.

---

## Running it

```bash
pnpm run dev                    # API :4000 + UI :5173, offline provider
pnpm test                       # 106 tests, none of which touch the network
pnpm run typecheck
```

Open a patient, press **Review checklist**, then **Explain this assessment** in the drawer.

To use a real model instead of the offline one:

```bash
ASSIST_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-… pnpm run api
```

| Variable | Default | Notes |
|---|---|---|
| `ASSIST_PROVIDER` | `stub` | `stub` or `anthropic` |
| `ANTHROPIC_API_KEY` | — | Required for `anthropic`; `ANTHROPIC_AUTH_TOKEN` also accepted |
| `ASSIST_MODEL` | `claude-opus-5` | |
| `ASSIST_TIMEOUT_MS` | `60000` | Per call, after which the response degrades |

### API

| Route | Returns |
|---|---|
| `POST /api/patients/:id/assist?asOf=` | `AssistResult` |

The six Part C and Part B routes are unchanged and still GET-only; this is the only POST in
the API.

**POST, not GET.** It is the only route in the API that spends money, and GET would license
a browser, a proxy or a prefetching link to spend it without a reviewer asking. Unknown
patient → 404; malformed `asOf` → 400. A provider failure is **not** an HTTP error — it comes
back 200 with a complete result whose `provenance.kind` is `deterministic`.

### Layout

```
backend/src/assist/
  dto.ts        wire types
  context.ts    assessment → the briefing + the set of refs a claim may cite
  schema.ts     ModelDraft, its JSON Schema, and a structural parser
  prompt.ts     the fixed system prompt + the per-patient briefing
  validate.ts   the grounding checks — pure, and the heart of this section
  fallback.ts   the deterministic draft, and the one assembler both paths use
  client.ts     ModelClient; StubClient and AnthropicClient
  index.ts      assistPatient — gather → draft → validate → assemble | degrade
frontend/src/components/
  Eligibility.tsx   the AI assist block inside the existing drawer
```

---

## 1. The trust boundary is structural

The brief's example output contains a determination, a per-requirement status, and the
resource ids each requirement was decided from. All three already existed — Part C computed
them. Asking a model to reproduce them would create a way to be wrong about something that
was already right, and would turn *"the AI must not override the deterministic logic"* into
a prompt instruction rather than a property of the system.

So the model is never asked. Its entire output schema is:

```ts
interface ModelDraft {
  summary: { text: string; evidence: string[]; unknown: boolean };   // one sentence
  requirementNotes: { requirementId: RequirementId; note: string }[];
  nextSteps: { text: string; requirementId: RequirementId | null }[];
}
```

There is no field for a determination. A model that wanted to change an outcome has nowhere
to put it, and one that asserts a different outcome *in prose* fails a grounding check
instead. The response the API returns is assembled in one function, `assemble`, which is the
only place in the codebase where these fields are set:

| Field | Source |
|---|---|
| `eligibilityAssessment` | Part C determination, verbatim |
| `checklist[].status` | Part C |
| `checklist[].evidence` | Part C |
| `checklist[].note` | model |
| `clinicalSummary` | model |
| `recommendedNextSteps` | Part C's gap list, worded by the model |

Note the last row: **which** steps appear is Part C's decision — one per unresolved
requirement — and the model only supplies the wording. A model that thought a fifth thing
was missing cannot add it to the list.

### What the model may cite

`context.ts` builds a closed set of citable refs from the assessment itself: the resources
Part C already cited, plus the `Patient` resource so demographic claims have something to
point at. Deriving the set from the assessment rather than from the store is deliberate —
otherwise a model could cite a real resource belonging to the patient that had nothing to do
with the decision, and the citation would resolve while the claim stayed unsupported.

Each ref keeps the tier Part C put it in (`accepted` / `related`), which is what makes the
conflict rule below checkable without any clinical knowledge in this layer.

---

## 2. Grounding

Ten rules, run against the draft before anything is assembled. Every one has a test.

| Rule | Violation |
|---|---|
| Every cited ref is in the citable set | `ungrounded-citation` |
| A claim with no evidence must be flagged `unknown` | `ungrounded-citation` |
| Every number in a claim appears in a resource that claim cites, or is a policy figure or the patient's age | `ungrounded-citation` |
| No hedging language (11 patterns) | `hedged-claim` |
| A claim citing `related` evidence must be flagged `unknown` | `conflict-resolved` |
| Prose must not assert an outcome other than the determination | `contradicts-determination` |
| A note must not describe a requirement as met unless Part C did | `contradicts-determination` |
| The summary is one sentence, under 200 characters | `incomplete-draft` |
| Exactly one note per requirement, no duplicates, non-empty summary | `incomplete-draft` |
| A next step may only target a requirement whose status is `unknown` | `incomplete-draft` |

### The summary is one line, and that is enforced

The brief's example is a single sentence — *"52-year-old female with long-standing morbid
obesity and hypertension."* — so `summary` is one object, not an array. A model given an array
writes an array, and the first version of this produced three joined sentences that restated
the checklist immediately below them.

Two checks hold the line, because a length cap alone would not: a model can fit three clipped
sentences into 200 characters. `SENTENCE_BREAK` rejects a terminator followed by more prose,
which is what "one line" actually means. Output against the real store:

```
[not-eligible] 36-year-old male with a BMI of 27.89 kg/m2 recorded 2022-06-23 and essential hypertension.
[not-eligible] 63-year-old female with a BMI of 28.22 kg/m2 recorded 2023-01-30, essential hypertension and hyperlipidemia.
[unknown     ] 34-year-old female with a BMI of 26 kg/m2 from 2020-09-14, outside the 24-month window.
```

The line orients a reviewer; it does not restate the checklist. Everything outstanding is in
the four rows and the next steps directly beneath it.

### `unknown` means "this claim is about a gap"

One flag covers two cases, and they are the same case. "No psychological evaluation is on
file" cannot cite a resource — the whole point is that no such resource exists. "Eleven
depression screens are recorded, none of which is an evaluation" *can* cite resources, but
must not read as though they settled the question. Both are claims about a gap, so both set
`unknown`, and that single flag is what the citation rule and the conflict rule both hang on.

### Conflicting evidence is stated, never resolved

Part C already separates evidence that satisfied a requirement from evidence that is
clinically adjacent and explicitly did not — a PHQ-9 is not a psychological evaluation, and
RxNorm `897122` is Victoza and Saxenda under one code. Those resources are put in the
briefing under `conflictingEvidence` with their caveats, and the model is told to state the
conflict rather than settle it.

The rule that enforces it needs no clinical judgement of its own: a claim citing a
`related` ref without `unknown` is writing up insufficient evidence as though it counted.
That is the liraglutide failure and the PHQ-9 failure, caught by one line of type-checking
against a tier Part C had already assigned.

### The two heuristics, stated as heuristics

The hedge lexicon and the number-traceability rule are not proofs. A model can write an
uncited claim in words the lexicon does not contain, and a claim with no numbers in it
cannot be caught by counting numbers. They bound the failure rather than eliminating it.

They are also deliberately **stricter than the brief**, which disallows "likely" / "probably"
/ "implied" *without evidence*. Here they are rejected outright, cited or not. The asymmetry
is the reason: a false reject costs a deterministic answer, and a false accept costs a
fabricated clinical statement in a prior-authorization review.

---

## 3. Failure handling

The brief names three failures. Each maps to a reason, a test, and the same outcome.

| Failure | Reason | Test |
|---|---|---|
| No provider configured | `no-provider` | env stubbed with no key |
| Transport, rate limit, 5xx, refusal | `model-error` | client throws `ModelCallError` |
| Deadline exceeded | `timeout` | client throws `ModelTimeoutError` |
| Not JSON, or wrong shape | `unparseable` | client throws `ModelShapeError` |
| Empty or partial response | `incomplete-draft` | drafts missing notes / summary |
| Conflicting evidence resolved | `conflict-resolved` | draft cites a caveated ref |
| Ungrounded, hedged, contradicting | three more reasons | one test each |

**Every one of them returns a complete `AssistResult`** — same fields, same citations, same
four-line checklist — differing only in `provenance`, which names what happened. The UI never
has to render an error where an explanation belongs, and a reviewer is never left with a
blank panel and no verdict explanation.

That is possible because the fallback is not a special case. `fallback.ts` composes a
`ModelDraft` from the assessment, and the *same* assembler turns it into a response. The
deterministic path is therefore exercised by every test that degrades, and — because it is a
draft like any other — it can be run through the grounding checks:

> **`the deterministic floor > passes its own grounding checks`** asserts that the house's own
> prose satisfies every rule it imposes on a model, across five different patient shapes.

That test earned its place immediately: it failed on first run because the
"describes a requirement as met" rule fired on Part C's own sentence *"BMI 28.4 is below 35,
so neither arm of the policy is satisfied"*. The rule could not read the negation. It now
scopes to a sentence and checks for a negation before the match.

### Rejection is total, and visible

A draft that trips any rule is discarded whole — not because salvaging the good half would
be hard, but because a model that fabricated one citation has told you what its other
sentences are worth. Every violation is carried on the response (`provenance.violations`)
with the path that failed, so a rejected draft is diagnosable from the UI rather than from a
server log.

---

## 4. Providers

`ModelClient` is a two-method interface, and it is the reason the failure handling above is
testable at all: "the provider timed out" is a one-line stub rather than a network fixture.

**`StubClient` is the default**, and it is a provider rather than a mock — it composes the
deterministic draft offline and goes through the same schema, validation, assembly and
provenance as a real one. So `pnpm run dev` produces a complete, validated, model-shaped
response on a machine with no credentials. Its prose is deliberately *not* better than the
fallback's: a stub that invented richer output would make the offline demo misrepresent what
it is.

**`AnthropicClient`** calls `claude-opus-5` with `output_config.format` set to the draft
schema, so a structurally wrong answer is prevented rather than detected. `parseDraft` runs
anyway — schema-constrained decoding is a property of one provider's API, not a guarantee
this codebase can make. No `temperature` or `top_p` (rejected on this model; steering is the
prompt's job), thinking left at its default, and a cache breakpoint on the system block,
which is byte-identical for every patient in the cohort.

---

## 5. Performance

| | |
|---|---|
| Assist, offline provider, cold | **175 ms** |
| …repeated | 0.7 ms |
| …different review date (cache miss) | 133 ms |

Two things carry this.

**The briefing does not read the snapshot.** The first version called
`getClinicalSnapshot`, which additionally reads conditions, procedures, the key-observation
panel and the resource mix — about 350 ms per call of work nothing in the briefing looks at.
It now calls the same three functions the snapshot uses for the part it needs
(`getPatientRecord`, `toDemographics`, `computeAge`), so the age in a summary is still the
age on the patient header. 500 ms → 133 ms.

**The cache is consulted before the assessment, not after.** Keying on the *requested* review
date rather than the resolved one means a repeat costs nothing rather than costing the
evidence gather again; the store is opened read-only, so the same key cannot resolve to a
different date later. Degraded responses are deliberately **not** cached — a transient
timeout should not pin a patient to the deterministic explanation for the life of the
process, and re-asking is what a reviewer who pressed the button again expects.

---

## 6. The UI

The assist block lives **inside** the eligibility drawer, **below** the deterministic
checklist, **behind** a button. That ordering is the section's argument in layout form: the
verdict a reviewer acts on is on the page before any model is consulted, and the model
explains it without being able to move it.

- The summary renders as one line with its citations as chips beneath it, in the same
  monospaced treatment the timeline uses, so it can be cross-checked against
  `GET /api/resources/:type/:id`.
- Model-written notes appear under each requirement's deterministic rationale, tagged `AI`.
  Colour is not used for the distinction — in this UI colour means data quality — so the
  separation is a label and a rule.
- A degraded response renders an amber banner naming the reason and listing every violation.
  The explanation below it is still complete.

---

## 7. Testing

**59 new tests** (42 in `assist.test.ts`, 17 in `routes.test.ts`); 106 in the suite. None
open a socket: every failure mode is a `ModelClient` that fails that way, and the offline
provider covers the happy path.

Stores are built by the real ingest pipeline and assessed by the real Part C evaluator, so
the refs a draft is checked against are refs the normalizer actually wrote. Two of the tests
build their context through `getClinicalSnapshot` while the orchestrator builds it through
`patients.ts` — a deliberate cross-check that the two agree.

`routes.test.ts` exists because Part D changed two load-bearing things about routing: the API
stopped being GET-only, and one route became asynchronous. It asserts that the other six
routes still refuse POST, that assist refuses GET, and that a rejected `asOf` is still
returned synchronously.

---

## 8. Known gaps

- **Cohort assist is out of scope.** The brief's hard requirements are all per-patient
  ("*When triggered for a single patient…*"). A cohort narrative would be grounded in report
  figures rather than resource ids, so it needs a different grounding rule set — real work,
  not a second endpoint over the same machinery, and it is not attempted here.
- **The grounding checks are bounded, not complete.** See §2. An uncited claim phrased
  outside the hedge lexicon and containing no numbers would pass.
- **The live provider path has not been run against the real API.** No credentials were
  available in this session. Its error mapping was exercised end to end against an
  unreachable endpoint (connection failure → `model-error`, complete degraded response), and
  its request construction is compile-checked against the SDK's types, but no response from
  `claude-opus-5` has been parsed by this code.
- **The UI was compile- and build-verified but not visually reviewed** — no browser was
  available, the same gap Parts B and C carry.
- **Unrelated, found while testing: Part C's lookback window has no upper bound.**
  `evaluateBmi` filters on `sortKey >= startMs` and never uses the `asOfMs` that
  `windowBounds` computes, so a BMI recorded *after* the review date counts as current. This
  cannot affect any default run — `asOf` defaults to the store's newest clinical date, so
  nothing can be later than it — and every number in `PART_C.md` is unaffected. It bites only
  when `--as-of` / `?asOf=` is set to a date earlier than the newest data, which is exactly
  the "score this cohort as it stood in 2021" case. Not fixed here: it is Part C's logic.
