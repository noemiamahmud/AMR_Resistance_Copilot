"""Derive the rifampicin-contact residues of rpoB from PDB 5UHC.

5UHC is an M. tuberculosis transcription initiation complex with rifampicin bound,
so these are measured ligand contacts rather than a hand-curated literature list.
Author numbering in 5UHC follows UniProt P9WGY9; clinical = uniprot - 6.
"""
import collections, json, sys, urllib.request

CIF, OUT = sys.argv[1], sys.argv[2]
CUTOFF, RPOB_CHAIN, OFFSET = 5.0, "C", 6

THREE = {'ALA':'A','ARG':'R','ASN':'N','ASP':'D','CYS':'C','GLN':'Q','GLU':'E',
         'GLY':'G','HIS':'H','ILE':'I','LEU':'L','LYS':'K','MET':'M','PHE':'F',
         'PRO':'P','SER':'S','THR':'T','TRP':'W','TYR':'Y','VAL':'V'}

uniprot = json.load(urllib.request.urlopen(
    "https://alphafold.ebi.ac.uk/api/prediction/P9WGY9"))[0]["sequence"]

cols, rows, inloop = [], [], False
for line in open(CIF):
    s = line.strip()
    if s.startswith("_atom_site."):
        cols.append(s.split(".")[1]); inloop = True; continue
    if inloop:
        if line.startswith(("ATOM", "HETATM")): rows.append(line.split())
        elif s == "#" and rows: break
i = {c: n for n, c in enumerate(cols)}

lig, prot = [], collections.defaultdict(list)
for f in rows:
    comp = f[i["auth_comp_id"]]
    xyz = tuple(float(f[i[k]]) for k in ("Cartn_x", "Cartn_y", "Cartn_z"))
    ch, seq = f[i["auth_asym_id"]], f[i["auth_seq_id"]]
    if comp == "RFP": lig.append(xyz)
    elif f[0] == "ATOM" and ch == RPOB_CHAIN: prot[(int(seq), comp)].append(xyz)
assert lig, "no RFP ligand found in %s" % CIF

residues, bad = [], []
for (seq, comp), ats in sorted(prot.items()):
    d = min(((x-a)**2 + (y-b)**2 + (z-c)**2) ** 0.5 for x, y, z in ats for a, b, c in lig)
    if d > CUTOFF: continue
    aa = THREE.get(comp, "X")
    if uniprot[seq - 1] != aa:
        bad.append((seq, aa, uniprot[seq - 1]))
    residues.append({"uniprotResnum": seq, "clinicalResnum": seq - OFFSET,
                     "aa": aa, "minDistanceToRifampicin": round(d, 2)})
assert not bad, "5UHC numbering disagrees with P9WGY9 at: %s" % bad

json.dump({
  "target": "rpoB", "organism": "Mycobacterium tuberculosis H37Rv", "drug": "rifampicin",
  "source": {"pdbId": "5UHC",
             "description": "M. tuberculosis transcription initiation complex with rifampicin",
             "ligandCode": "RFP", "rpoBAuthChain": RPOB_CHAIN,
             "contactCutoffAngstroms": CUTOFF,
             "method": "minimum heavy-atom distance from each rpoB residue to any rifampicin atom"},
  "numbering": {"clinicalReference": "NP_215181.1 (1172 aa) - CARD / WHO catalogue numbering",
                "uniprotReference": "P9WGY9 (1178 aa) - AlphaFold AF-P9WGY9-F1 numbering",
                "clinicalPlusOffsetEqualsUniprot": OFFSET},
  "residueCount": len(residues), "residues": residues}, open(OUT, "w"), indent=2)

print("wrote %d pocket residues, all validated against P9WGY9" % len(residues))
print("clinical numbering:", [r["clinicalResnum"] for r in residues])
