"""Prove the clinical (CARD/WHO) -> UniProt numbering offset for rpoB.

Fails loudly if the two reference sequences stop agreeing at the assumed offset.
"""
import json, os, sys, urllib.request

CARD_DIR = sys.argv[1]
ACCESSION, ARO, OFFSET = "P9WGY9", "ARO:3003283", 6

seqs, name = {}, None
fasta = os.path.join(CARD_DIR, "protein_fasta_protein_variant_model.fasta")
for line in open(fasta):
    if line.startswith(">"):
        name = line.strip(); seqs[name] = ""
    else:
        seqs[name] += line.strip()
card = next(v for k, v in seqs.items() if ARO in k)

uniprot = json.load(urllib.request.urlopen(
    f"https://alphafold.ebi.ac.uk/api/prediction/{ACCESSION}"))[0]["sequence"]

print(f"CARD reference : {len(card)} aa, starts {card[:10]}")
print(f"{ACCESSION}      : {len(uniprot)} aa, starts {uniprot[:16]}")

assert len(uniprot) - len(card) == OFFSET, "length difference is not the assumed offset"
mismatches = [(r, card[r - 1], uniprot[r + OFFSET - 1])
              for r in range(2, len(card) + 1)
              if card[r - 1] != uniprot[r + OFFSET - 1]]
assert not mismatches, f"offset +{OFFSET} does not hold: {mismatches[:10]}"

print(f"\nOK: clinical + {OFFSET} == UniProt, 0 mismatches over {len(card) - 1} residues.")
for r in (430, 435, 445, 450, 452, 491):
    print(f"  clinical {card[r-1]}{r} -> structure residue {r + OFFSET}")
