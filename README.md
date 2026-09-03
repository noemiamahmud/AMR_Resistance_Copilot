# AMR Resistance Copilot

A structure-grounded mechanistic interpreter for antimicrobial-resistance mutations.

Resistance catalogues (CARD, the WHO TB catalogue, ResFinder) are lists of mutations
someone has already seen. They say nothing about a mutation that isn't in them — and
genomic surveillance turns up novel mutations constantly. This tool reasons from the
target's 3D structure instead, so it can make a mechanistic call on a mutation no
database recognises, and explain the reasoning.

**Flagship target:** *Mycobacterium tuberculosis* RpoB + rifampicin.

## Status

Phase 4 complete — mutation → structure → mechanism → catalogue flag → agent + tool trace.

- Parses `rpoB S450L`, `rpoB p.Ser450Leu` and similar free text.
- Renders RpoB with the mutated residue, the rifampicin-contact shell, and the drug itself.
- Measures, from coordinates: closest approach to rifampicin, Cα distance, pLDDT at the
  residue, and burial as a self-calibrating neighbour-count percentile.
- Hands those measurements to a **local qwen3:8b** and gets back a schema-constrained
  mechanistic hypothesis: mechanism, resistance likelihood, caveat, what would confirm it.
- States plainly what a catalogue lookup alone returns — and for anything CARD has not
  already seen, that is nothing at all.
- Runs the same question a second way: an **agent** given the mutation string and no
  measurements, which has to call structural tools to obtain every number it uses, with
  the full call trace rendered under the answer.

Everything on this path runs from bundled local files and a model on the same machine —
no network call is made at request time, and no API key exists to leak.

## Run it

```bash
ollama serve                 # separate terminal
ollama pull qwen3:8b         # once, ~5 GB

npm install
npm run dev                  # http://localhost:3000
```

The hero case (`rpoB S450L`) is analysed automatically on load, and the page pre-warms
the model in the background so the first hypothesis is not paying a cold weight load.

Reasoning runs in one of two modes, switched in the UI: the fast **pipeline** or the
**agent**, which measures the structure itself and shows its tool trace.

`OLLAMA_HOST` (default `http://localhost:11434`) and `OLLAMA_MODEL` (default `qwen3:8b`)
override the defaults. With no model reachable the structural analysis still runs in
full; only the hypothesis panel reports itself unavailable.

## What is actually being measured

The AlphaFold monomer contains no drug, so "distance to the binding pocket" would
normally have to be inferred from a hand-curated list of contact residues. Instead,
`scripts/make_ligand_pose.py` superposes the rpoB chain of **PDB 5UHC** — an
M. tuberculosis transcription initiation complex with rifampicin bound — onto the
AlphaFold model (0.79 Å RMSD over 575 Cα atoms) and carries the crystallographic
ligand across. Distances reported by the app are therefore to a real rifampicin pose.

The pocket residue set is likewise measured, not curated: every rpoB residue within
5 Å of rifampicin in 5UHC. In clinical numbering it comes out as 167, 170, 428–435,
445, 448, 450, 452, 453, 459, 483, 487, 491, 604, 607, 674 — which contains every
canonical WHO rifampicin hotspot (L430, D435, H445, S450, L452, I491), with **S450 the
single closest contact at 2.43 Å**. That agreement is a useful independent check that
both the pocket derivation and the numbering below are right.

## What a catalogue can and cannot say

CARD holds 157 rpoB substitutions across 57 residues. Every one of them is a mutation
somebody has already seen, phenotyped and written up. Ask it about anything else and it
returns nothing — not "susceptible", not "unknown risk", nothing — and that is the state a
surveillance analyst is left in every time sequencing turns up something new.

So the tool answers the catalogue question explicitly, in a banner directly under the
structural call: **what would a lookup alone have told you?** For a novel mutation it says
so and keeps going, because the measurement and the mechanism never needed the catalogue.

`rpoB S450P` is the case to try. Residue 450 is the single closest contact to rifampicin
at 2.43 Å and CARD catalogues ten substitutions there — S450A, C, F, G, L, M, Q, V, W, Y.
Not P. A lookup returns nothing; the structure returns 2.71 Å, drug-contacting, pLDDT 96.9,
and the model calls it high likelihood. `rpoB N487D` is the same story on a contact residue
the catalogue has never touched at all.

The banner also names the catalogued resistance residues sitting within 8 Å in 3D. That is
context for the analyst, not evidence — it is catalogue knowledge, so it is kept out of the
payload the model reasons over, for the same reason the verdict itself is.

### When the two disagree

`rpoB E592D` is catalogued by CARD as resistance-associated and sits **21 Å** from the drug.
The structural read is *low*, and it is the structural read that is wrong: distal,
allosteric and compensatory resistance is invisible from the binding site. The tool says so
in the panel rather than quietly reconciling the two. Where a catalogue has phenotypic
evidence, the catalogue wins; the argument for this tool is only ever about the mutations a
catalogue is silent on.

## How the model is kept honest

The hypothesis comes from `qwen3:8b` running locally through Ollama. Two choices do the
work:

**It is shown measurements and nothing else.** The payload is the geometry — distance to
the drug, pLDDT, burial percentile, the physicochemistry of the substitution — plus a note
on how each number was obtained. The **catalogue verdict is deliberately withheld**, so the
model cannot recognise S450L and recite what it remembers. Whatever it says has to be
argued from the structure, which is what has to be true for the beyond-the-catalogue claim
in the later phases to mean anything. The exact payload is shown in the UI under *Evidence
handed to the model*.

**Output is schema-constrained.** The request goes to Ollama's native `/api/chat` with a
JSON schema in `format`, so decoding is constrained to the four fields rather than merely
asked for them — the difference between reliable structure and hopeful structure at 8B.
The native endpoint also takes `think: false`; qwen3 is a hybrid reasoning model and its
chain of thought costs tens of seconds that a live demo does not have, and the
OpenAI-compatible shim ignores the usual switches for turning it off. If the JSON is
unusable anyway, the call is retried without the schema and the prose is rendered instead.

Ranking it against the golden set is Phase 6's job; what Phase 2 shows is that the model's
verdict tracks the geometry — `S450L` at 2.71 Å reads *high*, `E592D` at 21 Å reads *low*.

## Two ways of asking the same question

The **pipeline** computes the features, hands the model a finished payload, and gets an
answer back in one call (~10–15 s). It is deterministic up to the model, and it is the
default.

The **agent** starts the model with a mutation string and nothing else. Every number it
uses has to come back from a tool call:

| Tool | Returns |
|---|---|
| `distance_to_drug(residue)` | minimum heavy-atom and Cα distance to rifampicin, proximity band, whether the residue is an observed contact |
| `plddt_at(residue)` | AlphaFold confidence at the residue |
| `burial_at(residue)` | neighbour count within 10 Å, as a percentile of this structure |
| `neighbors_within(residue, radius)` | what the side chain is actually packed against |
| `catalogue_lookup(mutation)` | the CARD entry, or an explicit "no entry" |

These are thin wrappers over the functions the pipeline already calls, against the same
bundled structure, so the two paths cannot quietly drift apart. Every tool takes and
returns **clinical** numbering and converts internally — the +6 offset below is exactly the
kind of thing that must not be left to a model.

A typical run on `rpoB S450P` takes five turns and about a minute:

```
1. catalogue_lookup {"mutation":"rpoB S450P"}  → known: false, "A catalogue lookup ends here"
2. distance_to_drug {"residue":450}            → 2.71 Å, drug-contacting
3. plddt_at         {"residue":450}            → 96.9, very high
4. burial_at        {"residue":450}            → 68th percentile, buried
5. neighbors_within {"residue":450,"radius":6} → 16 residues, nearest L449 at 1.33 Å
```

The model picked that sequence itself, and the answer cites those numbers. What makes the
trace worth showing is that it is **complete**: a claim about a distance nobody measured is
not merely discouraged, it is unavailable. If the model tries to answer before measuring
anything, it is asked again and the panel records that it did.

Tool turns and the answer turn are separate calls. Constrained decoding to the answer
schema leaves no room to emit a tool call instead, so the loop runs unconstrained with
tools and only the final turn is schema-bound.

One deliberate asymmetry: the agent **may** consult the catalogue, and the pipeline may
not. Seeing `catalogue_lookup` come back empty and the model keep going is the argument
made in one screen. But it does mean the agent path is not catalogue-blind, so the
Phase 6 eval will score the pipeline, which is.

## The numbering trap

CARD and the WHO catalogue number rpoB against **NP_215181.1 (1172 aa)**. UniProt
**P9WGY9 (1178 aa)** — and so both the AlphaFold model and 5UHC — carry a six-residue
N-terminal extension (`MLEGCI`).

**Clinical S450 is residue 456 in the structure.** Residue 450 of the structure is a
threonine. Highlighting residue 450 directly would quietly display the wrong residue,
about 5 Å off, and every number downstream of it would be wrong while still looking
plausible.

The app takes clinical numbering as input (what a surveillance analyst actually has),
displays both, and validates the wild-type amino acid you typed against the sequence.
`scripts/verify_numbering.py` proves the +6 alignment holds with zero mismatches
across all 1171 shared residues.

## Data provenance

| Asset | Source |
|---|---|
| `public/hero.pdb` | AlphaFold DB `AF-P9WGY9-F1-model_v6.pdb` (note: **v6**; the widely-cited v4 URL is dead) |
| `public/data/rifampicin-pose.pdb` | PDB 5UHC ligand RFP, superposed onto the AlphaFold model |
| `public/data/pocket-rpob-rifampicin.json` | rpoB residues within 5 Å of rifampicin in 5UHC |
| `public/data/card-rpob-rifampicin.json` | CARD `snps.txt`, ARO:3003283 — 157 substitutions |

See [scripts/README.md](scripts/README.md) to regenerate any of these from primary sources.

## Caveats

- Pocket distance is a geometric measurement against a transplanted crystallographic
  ligand pose. It is **not** docking or a computed binding affinity.
- The structure is an AlphaFold monomer; the real target is a multi-subunit holoenzyme.
- The agent costs five or six model round trips, about a minute on an M2. It is the
  transparency story, not the fast path.
- The mechanism text is generated by an 8B model from the measurements above. It is a
  hypothesis to check, not a validated prediction, and it inherits whatever the geometry
  cannot see (allostery, holoenzyme context, fitness cost).
- This is a surveillance triage and hypothesis aid, **not a diagnostic**.
- CARD and the WHO catalogue are prior art. The point here is to generalise beyond
  them, not to replace them — and for a catalogued mutation their evidence outranks
  anything measured here.
- "Novel" means absent from the bundled CARD export, which is a snapshot. It does not
  mean absent from the literature.

## Stack

Next.js 16 · React 19 · Tailwind 4 · 3Dmol.js · Ollama (`qwen3:8b`, local) for the
mechanistic reasoning.
