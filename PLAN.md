# Plan v4 — a capability harness for biological foundation models

## Feasibility first

This plan is constrained to what runs on a single Apple Silicon laptop plus free or
already-held API access. That constraint is stated up front because it determines the
design, and because a plan that quietly assumes a GPU cluster is not a plan.

| Model | Where it runs | Throughput | Verdict |
|---|---|---|---|
| **ESM2 / ESM-1v** (650M) | **Locally**, MPS or CPU, via HuggingFace `transformers` | Effectively unlimited — one forward pass per variant | **The workhorse.** Exhaustive, high-N probing with no rate limit |
| **Boltz-2** | NVIDIA NIM (cloud, key already held) | ~4 min/run, rate-limited | **The flagship.** Low-N, carefully designed, run overnight |
| **ESM2 3B** | Locally in fp16 (~6 GB) | Slow but workable | Stretch — use if 650M results warrant a scale axis |
| **ESMFold** (3B) | Locally, borderline on 16 GB unified | Very slow | Stretch only |
| **AlphaFold2** | ColabFold on Colab free tier | Rate-limited, session-capped | Optional third model |
| **AlphaFold3** | Weights are gated; Server has no API | — | **Not available. Say so in the writeup.** |
| **Chai-1** | Needs a real GPU locally | — | Only if their hosted free tier permits |

**What this makes possible:** a genuine two-family comparison — a sequence model that
never sees structure against a co-folding model that predicts one — on a shared
perturbation class with real clinical labels. That is a legitimate study.

**What it rules out**, and the writeup must say so plainly: any claim of comprehensive
coverage across co-folding models; any AlphaFold3 result; anything needing more than a
few hundred Boltz-2 calls total; any fine-tuning.

The compute budget is not a footnote. It forces the central architectural decision
below, and designing well against a hard budget is a better engineering signal than
having no budget at all.

---

## What this is, in plain language

Biological foundation models are being used every day to answer questions nobody
checked they could answer. Boltz-2 was trained to tell one drug molecule from another
against a fixed protein. People are now using it to ask the reverse question — does
*this mutation in the protein* change how the drug binds — which is a different
question, and there is mounting evidence the model cannot see it. AlphaFold is used to
assess the impact of point mutations despite its own authors cautioning that it barely
responds to them.

**This project is a system that finds out, automatically, what a given model can and
cannot see.**

You give it a model and a kind of perturbation. It designs probes, runs them with
enforced replication, and produces a **capability map**: the size of effect this model
can resolve, under what conditions, and where it goes blind. Run it across several
models and you get the comparison that does not currently exist.

The origin is a result already in this repo. Boltz-2 was asked whether rpoB S450L — one
of the best-established resistance mutations in bacteriology — binds rifampicin
differently from wild type. It cannot tell. The first pair of runs said "2× weaker,"
which was the expected answer and was noise; five replicates per arm showed the effect
was a tenth of a log unit against a standard error the same size. That is one data
point on one model with one mutation, obtained by hand. This plan turns it into a
system.

## Why this and not the alternatives

**Not another predictor.** Structure-based resistance prediction is occupied —
per-drug ML tools from the Ascher lab since 2020, and proteome-scale 3D-context work at
F1 94.6%. A better predictor is not on offer here.

**Not a fine-tuned model.** Training a small model on a small dataset against a solved
task produces something worse than published work, and demonstrates recipe-following
rather than judgment.

**Not an agent framework.** Agents appear here where they earn their place — probe
design and result triage — not as the pitch.

The gap this fills: individual adversarial probes of these models have been published
as one-off studies. **Nobody has built the reproducible system that does it across
models and perturbation classes with real clinical ground truth rather than synthetic
knockouts.** Labs are structurally bad at red-teaming their own models, which is what
makes a rigorous external capability map worth having.

---

## What the system does

### The core loop

```
model + perturbation class + compute budget
        │
        ├── plan       select the most informative probes affordable within budget
        ├── run        execute with enforced replication, checkpointed and resumable
        ├── analyse    effect size vs. measured noise floor, per probe
        └── map        the capability boundary: resolvable above X, blind below
```

### The two primitives that make it more than a benchmark script

**Replication is the interface.** A stochastic model cannot be called once through this
API and yield a bare number. Every comparison returns an effect size *and* the noise
floor measured from its own replicates, plus a `resolvable` flag. Reporting an
unresolvable delta requires deliberate effort.

```python
result = probe.compare(wild_type, mutant, replicates=5)

result.effect_size    # -0.10 log10 IC50
result.noise_floor    # 0.21, measured, not assumed
result.resolvable     # False
result.report()
# "Δ = −0.10 ± 0.11 (0.9σ). Below this model's measured resolution
#  on this perturbation class; no directional claim is supported."
```

**Budget-aware probe planning.** With ~200 Boltz-2 calls affordable in total, which 200
answer the most? The planner ranks candidate probes by expected information — spanning
the range of effect sizes the ground truth says should exist, prioritising the boundary
region where the model's resolution is uncertain rather than re-confirming the easy
extremes. This is the piece the compute constraint forces, and it is the most
interesting engineering in the project.

### The ground truth

The WHO catalogue of *M. tuberculosis* mutations is a rare asset: thousands of protein
point mutations with graded phenotypic evidence, and MIC distributions for many. That
gives probes a *known expected effect size*, which is what turns "the model gave a
number" into "the model failed to see an effect we know is there."

Both catalogue editions exist in normalised machine-readable form (the Oxford GARC
CSVs), so this is a small local file, not a data engineering project.

### The agent layer, where it earns its place

Two jobs, both genuinely better with a model in the loop and both cheap on a local 8B:

- **Probe design** — given a target and a ground-truth set, propose perturbations that
  span the informative range, with a rationale recorded per proposal.
- **Result triage** — over a completed run, flag which boundaries look real versus
  which are artefacts of too few replicates, and draft the capability-map prose.

Exposed as MCP tools so the harness is drivable by any agent, and so every measurement
carries a trace of how it was obtained. Descendant of the tool-trace work already in
this repo, which established the useful property that an agent given only measurement
tools cannot cite a number nobody measured.

---

## Architecture

Working name **`probeworks`** — check PyPI before committing.

```
probeworks/
├── models/       adapters: one per model, behind a common protocol
├── perturb/      perturbation classes: point mutation, truncation, ligand swap, shuffle
├── truth/        ground-truth loaders: WHO catalogue, CARD, MIC tables
├── plan/         budget-aware probe selection
├── run/          execution: replication, checkpointing, resume, rate-limit handling
├── analyse/      effect size, noise floor, resolvability, aggregation
├── agent/        MCP server + tool schemas for probe design and triage
└── report/       capability maps, provenance chains, methods text
```

Layers depend only downward, enforced by an import-linter contract in CI.

### `models` — the extension point

One protocol, so adding a model is a plugin rather than a fork:

```python
class Model(Protocol):
    name: str
    stochastic: bool
    def score(self, inputs: ModelInput) -> ModelOutput: ...
    def capability(self) -> CapabilityDeclaration: ...
```

Ships with `ESM2` (local), `Boltz2NIM` (cloud), and a `Recorded` adapter that replays
saved responses — which is what makes the whole package testable offline and what makes
a week-long overnight run reproducible afterwards.

### `run` — the part that has to survive a laptop

Because a Boltz-2 study is days of overnight batches on a rate-limited free tier, the
runner is checkpointed and resumable by construction: every completed replicate is
persisted immediately, a resumed run re-executes nothing, rate-limit responses back off
rather than fail the batch, and a killed process loses at most one call. This is
unglamorous and it is the difference between a study that finishes and one that doesn't.

### The existing app

The Next.js application stays, repointed at the harness as its front end — the
capability maps and the replicate scatter plots are things worth looking at, and the
existing structure viewer and affinity panel are most of the UI already. It remains the
worked example and the visual proof.

---

## Testing and CI

The test suite is part of what is being demonstrated, so it is designed rather than
accumulated.

| Kind | Tool | Covers |
|---|---|---|
| **Property-based** | Hypothesis | Effect-size and noise-floor maths; invariants like "more replicates never widens the reported floor"; planner budget never exceeded |
| **Refusal tests** | `pytest.raises` | Calling a stochastic model without replication; requesting a probe over budget; claiming resolvability below the floor. Each must **raise**, not warn |
| **Recorded-response** | the `Recorded` adapter | Full pipeline runs offline in CI from saved model outputs |
| **Determinism** | fixtures | Same seed, same plan, same probe selection |
| **Resume** | integration | Kill mid-run, resume, assert no duplicated calls and identical final state |
| **Live** | `-m slow` | Real NIM calls. Nightly schedule, never on PRs |

**CI**: GitHub Actions across supported Python versions; `ruff`; `mypy --strict`;
`pytest` with coverage gated on core layers; import-linter for the layering contract;
docs build. Pre-commit mirrors the same hooks. Tag-triggered PyPI release via trusted
publishing. Docs on mkdocs-material with mkdocstrings.

---

## Phases

Every phase ends with something real: *the harness answers a question about a model
that nobody had measured before, and the answer is reproducible.*

### Phase 1 — Harness skeleton, ESM2 first

`models`, `perturb`, `run`, `analyse` end to end against ESM2 locally. ESM2 is
deterministic, free and fast, which makes it the right model to build the machinery
against before spending a single rate-limited call.

**Checkpoint:** a capability map for ESM2 on point mutations across the WHO
ground-truth set, produced by one command, reproducible from a seed.

### Phase 2 — Replication, noise floors, and the resolvability primitive

The statistics, properly: effect size against measured spread, the `resolvable` flag,
and the refusal tests that enforce it.

**Checkpoint:** replay the existing hand-run Boltz-2 S450L data through the harness and
reproduce the published null — same numbers, now from a system rather than by hand.

### Phase 3 — Budget-aware planning

The probe planner. Given N affordable calls, choose the N most informative.

**Checkpoint:** the planner, given a 200-call budget, selects a probe set that
characterises the boundary better than 200 randomly chosen probes — demonstrated by
running both against ESM2, where calls are free and the comparison is affordable.

### Phase 4 — Boltz-2 at scale, overnight

Point the harness at the NIM with the Phase 3 plan. Days of checkpointed overnight
batches. This is the flagship experiment.

**Checkpoint:** the first real capability map for Boltz-2 on clinically-grounded
protein point mutations — an effect-size floor with confidence bounds, rather than an
adversarial anecdote.

### Phase 5 — Comparison and the agent layer

Add ColabFold/AF2 if the free tier holds. MCP server, probe-design and triage tools.

**Checkpoint:** a two- or three-model comparison on one perturbation class, and an
agent that can drive a fresh probe run end to end with a complete trace.

### Phase 6 — Package, document, release

Cookbook, the failure gallery, the capability maps as published artefacts, `1.0.0`.

**Checkpoint:** someone else installs it, points it at a model this repo has never
tested, and gets a capability map.

---

## Non-goals and honest limits

- **Not a resistance predictor**, and not competing with published ones.
- **Not comprehensive across co-folding models.** AlphaFold3's weights are gated and
  local co-folding is out of reach on this hardware. The writeup states which models
  were and were not testable, and why.
- **Not a training project.** Nothing here is fine-tuned.
- **Statistically modest by construction.** A few hundred Boltz-2 calls supports a
  capability *boundary with error bars*, not a definitive characterisation. The reported
  confidence intervals must reflect the sample size honestly — which, given this
  project's entire premise, is non-negotiable.
- **One perturbation class deeply, before others broadly.** Point mutations first,
  because that is where ground truth exists. Truncation, ligand swap and shuffle are
  designed for in the API and implemented later.

## Open decisions

- Package name — check PyPI before Phase 1.
- ESM2 650M vs 3B as the default local model: start at 650M, add scale as an axis only
  if the 650M map shows something worth scaling.
- Whether variant scoring uses masked-marginal or pseudo-likelihood — affects cost per
  variant materially; spike in Phase 1.
- Whether ColabFold is worth the free-tier friction, decided after Phase 4 shows how
  much a third model would add.
- How much of the existing Next.js app to keep versus rebuild around capability maps as
  the primary object.
