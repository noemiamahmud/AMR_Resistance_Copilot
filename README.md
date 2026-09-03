# AMR Resistance Copilot

A structure-grounded mechanistic interpreter for antimicrobial-resistance mutations.

Resistance catalogues (CARD, the WHO TB catalogue, ResFinder) are lists of mutations
someone has already seen. They say nothing about a mutation that isn't in them — and
genomic surveillance turns up novel mutations constantly. This tool reasons from the
target's 3D structure instead, so it can make a mechanistic call on a mutation no
database recognises, and explain the reasoning.

**Flagship target:** *Mycobacterium tuberculosis* RpoB + rifampicin.

## Status

Phase 1 complete — mutation → structure → measured distance to the drug.

- Parses `rpoB S450L`, `rpoB p.Ser450Leu` and similar free text.
- Renders RpoB with the mutated residue, the rifampicin-contact shell, and the drug itself.
- Measures, from coordinates: closest approach to rifampicin, Cα distance, pLDDT at the
  residue, and burial as a self-calibrating neighbour-count percentile.
- Flags the mutation as known or novel against CARD.

Everything on this path runs from bundled local files — no network call is made at
request time.

## Run it

```bash
npm install
npm run dev     # http://localhost:3000
```

The hero case (`rpoB S450L`) is analysed automatically on load.

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
- This is a surveillance triage and hypothesis aid, **not a diagnostic**.
- CARD and the WHO catalogue are prior art. The point here is to generalise beyond
  them, not to replace them.

## Stack

Next.js 16 · React 19 · Tailwind 4 · 3Dmol.js · Ollama (`qwen3:8b`, local) for the
reasoning phases still to come.
