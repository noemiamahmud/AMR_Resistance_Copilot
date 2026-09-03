# AMR Resistance Copilot

A structure-grounded mechanistic interpreter for antimicrobial-resistance mutations.

Resistance catalogues (CARD, the WHO TB catalogue, ResFinder) are lists of mutations
someone has already seen. They say nothing about a mutation that isn't in them — and
genomic surveillance turns up novel mutations constantly. This tool reasons from the
target's 3D structure instead, so it can make a mechanistic call on a mutation no
database recognises, and explain the reasoning.

**Flagship target:** *Mycobacterium tuberculosis* RpoB + rifampicin.

## Status

Phase 2 complete — mutation → structure → measured distance to the drug → mechanism.

- Parses `rpoB S450L`, `rpoB p.Ser450Leu` and similar free text.
- Renders RpoB with the mutated residue, the rifampicin-contact shell, and the drug itself.
- Measures, from coordinates: closest approach to rifampicin, Cα distance, pLDDT at the
  residue, and burial as a self-calibrating neighbour-count percentile.
- Hands those measurements to a **local qwen3:8b** and gets back a schema-constrained
  mechanistic hypothesis: mechanism, resistance likelihood, caveat, what would confirm it.
- Flags the mutation as known or novel against CARD.

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
- The mechanism text is generated by an 8B model from the measurements above. It is a
  hypothesis to check, not a validated prediction, and it inherits whatever the geometry
  cannot see (allostery, holoenzyme context, fitness cost).
- This is a surveillance triage and hypothesis aid, **not a diagnostic**.
- CARD and the WHO catalogue are prior art. The point here is to generalise beyond
  them, not to replace them.

## Stack

Next.js 16 · React 19 · Tailwind 4 · 3Dmol.js · Ollama (`qwen3:8b`, local) for the
mechanistic reasoning.
