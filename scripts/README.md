# Data generation

The files in `public/` and `public/data/` are derived from primary sources. These
scripts regenerate them; they need network access and `numpy`.

```bash
# 1. Hero structure - AlphaFold model of M. tuberculosis RpoB (P9WGY9).
#    Note the version: the v4 URL that older docs cite is dead, AFDB is on v6.
curl -o public/hero.pdb https://alphafold.ebi.ac.uk/files/AF-P9WGY9-F1-model_v6.pdb

# 2. Experimental complex - Mtb transcription initiation complex with rifampicin.
curl -o /tmp/5uhc.cif https://files.rcsb.org/download/5UHC.cif

# 3. CARD resistance catalogue.
curl -L -o /tmp/card.tar.bz2 https://card.mcmaster.ca/latest/data
mkdir -p /tmp/card && tar xjf /tmp/card.tar.bz2 -C /tmp/card

# 4. Derived data files.
python3 scripts/verify_numbering.py /tmp/card
python3 scripts/make_pocket.py      /tmp/5uhc.cif public/data/pocket-rpob-rifampicin.json
python3 scripts/make_ligand_pose.py /tmp/5uhc.cif public/hero.pdb public/data/rifampicin-pose.pdb
python3 scripts/make_catalogue.py   /tmp/card public/data/card-rpob-rifampicin.json
```

## Affinity cache (stretch)

`public/data/affinity-cache.json` holds real Boltz-2 NIM runs so the app can show a
wild-type-versus-mutant affinity comparison instantly rather than waiting on a
rate-limited cloud GPU. It needs an NVIDIA API key and takes roughly a minute per
replicate pair.

```bash
NVIDIA_API_KEY=nvapi-... node scripts/make_affinity_cache.mjs S450L 5
```

The replicates are not optional padding. Boltz-2's diffusion is stochastic, and repeated
runs of the *identical* wild-type sequence span about half a log unit — wider than the
wild-type/mutant difference being looked for. One run of each arm produces a confident
number pointing in an arbitrary direction, so the script always runs several and the app
reports the difference against that spread. Nothing in the cache may be synthetic; if a
number in it did not come back from the API, the panel it feeds is a lie.

## The numbering trap

CARD and the WHO catalogue number rpoB against **NP_215181.1 (1172 aa)**. UniProt
**P9WGY9 (1178 aa)** — and therefore both the AlphaFold model and PDB 5UHC — carry a
six-residue N-terminal extension (`MLEGCI`). So the canonical clinical mutation
**S450L is residue 456 in the structure**, and residue 450 of the structure is a
threonine. Highlighting residue 450 directly would silently show the wrong residue.

`verify_numbering.py` proves the +6 alignment (0 mismatches over all 1171 shared
residues) and is worth re-running whenever a source file is refreshed.
