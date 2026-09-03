"""Transplant the crystallographic rifampicin pose into the AlphaFold frame.

The AlphaFold monomer has no drug in it. Superposing 5UHC's rpoB chain onto the
AlphaFold model lets us carry the real ligand across, so distances are measured to
an actual rifampicin pose rather than inferred from proxy residues.
"""
import sys
import numpy as np

CIF, HERO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
RPOB_CHAIN, NEAR = "C", 30.0

cols, rows, inloop = [], [], False
for line in open(CIF):
    s = line.strip()
    if s.startswith("_atom_site."):
        cols.append(s.split(".")[1]); inloop = True; continue
    if inloop:
        if line.startswith(("ATOM", "HETATM")): rows.append(line.split())
        elif s == "#" and rows: break
i = {c: n for n, c in enumerate(cols)}

xtal_ca, rfp = {}, []
for f in rows:
    xyz = tuple(float(f[i[k]]) for k in ("Cartn_x", "Cartn_y", "Cartn_z"))
    comp, ch, seq = f[i["auth_comp_id"]], f[i["auth_asym_id"]], f[i["auth_seq_id"]]
    atom, elem = f[i["auth_atom_id"]], f[i["type_symbol"]]
    if comp == "RFP": rfp.append((atom, elem, xyz))
    elif f[0] == "ATOM" and ch == RPOB_CHAIN and atom == "CA": xtal_ca[int(seq)] = xyz
assert rfp, "no RFP ligand found"

af_ca = {}
for line in open(HERO):
    if line.startswith("ATOM") and line[12:16].strip() == "CA":
        af_ca[int(line[22:26])] = (float(line[30:38]), float(line[38:46]), float(line[46:54]))

L = np.array([x for _, _, x in rfp])
near = {r for r, c in xtal_ca.items()
        if np.min(np.linalg.norm(L - np.array(c), axis=1)) < NEAR}
common = sorted(near & set(af_ca))
assert len(common) > 100, "too few shared residues to superpose (%d)" % len(common)

P = np.array([xtal_ca[r] for r in common])   # moving (crystal)
Q = np.array([af_ca[r] for r in common])     # target (AlphaFold)
cp, cq = P.mean(0), Q.mean(0)
U, _, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
d = np.sign(np.linalg.det(Vt.T @ U.T))
R = Vt.T @ np.diag([1, 1, d]) @ U.T

def apply(pts):
    return (np.asarray(pts) - cp) @ R.T + cq

rmsd = float(np.sqrt(((apply(P) - Q) ** 2).sum(1).mean()))
print("superposition RMSD: %.2f A over %d CA atoms" % (rmsd, len(common)))
assert rmsd < 2.0, "superposition is too poor to trust"

moved = apply(L)
with open(OUT, "w") as fh:
    fh.write("REMARK   rifampicin pose from PDB 5UHC (ligand RFP, rpoB chain %s)\n" % RPOB_CHAIN)
    fh.write("REMARK   superposed onto AlphaFold AF-P9WGY9-F1 using %d CA atoms, RMSD %.2f A\n"
             % (len(common), rmsd))
    for n, ((atom, elem, _), xyz) in enumerate(zip(rfp, moved), 1):
        fh.write("HETATM%5d %-4s RFP X 501    %8.3f%8.3f%8.3f  1.00  0.00          %2s\n"
                 % (n, atom[:4], xyz[0], xyz[1], xyz[2], elem))
    fh.write("END\n")
print("wrote %s with %d ligand atoms" % (OUT, len(rfp)))

for uni, label in [(456, "S450"), (451, "H445"), (441, "D435"), (100, "control")]:
    if uni in af_ca:
        print("  structure %d (%s): %.2f A to drug"
              % (uni, label, np.min(np.linalg.norm(moved - np.array(af_ca[uni]), axis=1))))
