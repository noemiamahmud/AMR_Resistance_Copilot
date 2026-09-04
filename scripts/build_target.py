"""Build every derived asset for one target in scripts/targets.json.

Replaces the three single-target scripts with one manifest-driven builder, so adding a
drug target is a data edit rather than a code change.

Three things are verified rather than assumed, because each is a way to be silently and
plausibly wrong:

  * The clinical-to-structure offset is re-derived from the catalogue itself, by finding
    the shift that makes every catalogued wild-type residue agree with the AlphaFold
    sequence. If the manifest disagrees with what the data says, the build stops.
  * The crystal chain is checked residue by residue against the AlphaFold sequence before
    superposing. Aligning the wrong chain, or a chain numbered against a different
    reference, would still produce a rotation matrix and a plausible-looking pose.
  * Catalogue entries whose wild-type residue disagrees with the structure are dropped and
    counted, not quietly kept.

Usage:
    python3 scripts/build_target.py <target-id> [--card /tmp/card] [--cache /tmp]
    python3 scripts/build_target.py --all
"""
import argparse, csv, json, os, re, shutil, sys, urllib.request
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "scripts", "targets.json")
PUBLIC = os.path.join(ROOT, "public")

THREE = {'ALA':'A','ARG':'R','ASN':'N','ASP':'D','CYS':'C','GLN':'Q','GLU':'E',
         'GLY':'G','HIS':'H','ILE':'I','LEU':'L','LYS':'K','MET':'M','PHE':'F',
         'PRO':'P','SER':'S','THR':'T','TRP':'W','TYR':'Y','VAL':'V'}
SUB = re.compile(r'^([ACDEFGHIKLMNPQRSTVWY])(\d+)([ACDEFGHIKLMNPQRSTVWY])$')

CONTACT_CUTOFF = 5.0          # angstroms; what counts as a drug contact residue
SUPERPOSE_RADIUS = 30.0       # only align the neighbourhood of the site, not the whole fold


def fetch(url, dest):
    if not os.path.exists(dest):
        print(f"    fetching {url}")
        urllib.request.urlretrieve(url, dest)
    return dest


def alphafold(acc, cache):
    meta = json.load(urllib.request.urlopen(
        f"https://alphafold.ebi.ac.uk/api/prediction/{acc}", timeout=60))[0]
    pdb = fetch(meta["pdbUrl"], os.path.join(cache, f"af-{acc}.pdb"))
    return meta["sequence"], pdb


def read_cif_atoms(path):
    """The _atom_site loop as a list of dicts. Enough for coordinates and identity."""
    cols, rows, inloop = [], [], False
    for line in open(path):
        s = line.strip()
        if s.startswith("_atom_site."):
            cols.append(s.split(".")[1]); inloop = True; continue
        if inloop:
            if line.startswith(("ATOM", "HETATM")):
                rows.append(line.split())
            elif s == "#" and rows:
                break
    i = {c: n for n, c in enumerate(cols)}
    return i, rows


def ca_from_pdb(path):
    out = {}
    for line in open(path):
        if line.startswith("ATOM") and line[12:16].strip() == "CA":
            out[int(line[22:26])] = (float(line[30:38]), float(line[38:46]), float(line[46:54]))
    return out


def derive_offset(entries_muts, seq):
    """The shift that best reconciles catalogue numbering with the structure sequence."""
    best = (0, -1)
    for off in range(-10, 21):
        ok = sum(1 for wt, n in entries_muts
                 if 0 <= n + off - 1 < len(seq) and seq[n + off - 1] == wt)
        if ok > best[1]:
            best = (off, ok)
    return best


def build(t, card_dir, cache):
    print(f"\n=== {t['id']}  ({t['gene']} + {t['drug']}) ===")
    seq, af_pdb = alphafold(t["uniprotAccession"], cache)
    print(f"    AlphaFold {t['uniprotAccession']}: {len(seq)} residues")

    # ---- catalogue, and the offset it implies -------------------------------------
    rows = [r for r in csv.DictReader(open(os.path.join(card_dir, "snps.txt")), delimiter="\t")
            if r["Accession"] == t["aro"]]
    if not rows:
        sys.exit(f"    no CARD rows for ARO:{t['aro']}")

    parsed_muts, nonsub = set(), 0
    for r in rows:
        for m in (x.strip() for x in r["Mutations"].split(",") if x.strip()):
            p = SUB.match(m)
            if p:
                parsed_muts.add((p.group(1), int(p.group(2))))
            else:
                nonsub += 1

    offset, matched = derive_offset(parsed_muts, seq)
    print(f"    CARD ARO:{t['aro']}: {len(rows)} rows, {len(parsed_muts)} distinct substitutions")
    print(f"    derived offset +{offset} reconciles {matched}/{len(parsed_muts)}")
    if offset != t["clinicalToUniprotOffset"]:
        sys.exit(f"    manifest says offset {t['clinicalToUniprotOffset']}, data says {offset}. Stopping.")

    entries, dropped = [], []
    for r in rows:
        muts = [m.strip() for m in r["Mutations"].split(",") if m.strip()]
        for m in muts:
            p = SUB.match(m)
            if not p:
                continue
            wt, n, mu = p.group(1), int(p.group(2)), p.group(3)
            idx = n + offset - 1
            if not (0 <= idx < len(seq)) or seq[idx] != wt:
                dropped.append(f"{m} (structure has {seq[idx] if 0 <= idx < len(seq) else '-'})")
                continue
            entries.append({
                "mutation": m, "wildType": wt, "clinicalResnum": n, "mutant": mu,
                "aro": "ARO:" + t["aro"], "variantType": r["Parameter Type"],
                "partOfCombination": muts if len(muts) > 1 else None,
                "evidence": r["source"], "citation": r["citation"],
            })
    best = {}
    for e in entries:
        prev = best.get(e["mutation"])
        if prev is None or (prev["partOfCombination"] and not e["partOfCombination"]):
            best[e["mutation"]] = e
    kept = sorted(best.values(), key=lambda e: (e["clinicalResnum"], e["mutant"]))
    if dropped:
        print(f"    dropped {len(set(dropped))} entries disagreeing with the structure: "
              f"{sorted(set(dropped))[:4]}")

    # ---- crystal complex: ligand + the chain it sits on ----------------------------
    cif = fetch(f"https://files.rcsb.org/download/{t['complexPdbId']}.cif",
                os.path.join(cache, f"{t['complexPdbId']}.cif"))
    i, rows_cif = read_cif_atoms(cif)
    copies, xtal_ca, xtal_seq = {}, {}, {}
    for f in rows_cif:
        xyz = tuple(float(f[i[k]]) for k in ("Cartn_x", "Cartn_y", "Cartn_z"))
        comp, ch, seqid = f[i["auth_comp_id"]], f[i["auth_asym_id"]], f[i["auth_seq_id"]]
        atom, elem = f[i["auth_atom_id"]], f[i["type_symbol"]]
        if comp == t["ligandCode"]:
            copies.setdefault((ch, seqid), []).append((atom, elem, xyz))
        elif f[0] == "ATOM" and ch == t["complexChain"]:
            n = int(seqid)
            xtal_seq[n] = THREE.get(comp, "X")
            if atom == "CA":
                xtal_ca[n] = xyz
    if not copies:
        sys.exit(f"    ligand {t['ligandCode']} not found in {t['complexPdbId']}")
    if not xtal_ca:
        sys.exit(f"    chain {t['complexChain']} not found in {t['complexPdbId']}")

    # A complex often holds several copies of the drug - in a gyrase cleavage complex they
    # are even assigned to the DNA chains rather than the protein. Only the copy bound to
    # the chain we superpose is in the right frame afterwards; keeping them all would put
    # phantom ligand density next to the monomer and shrink every distance downstream.
    chain_xyz = np.array(list(xtal_ca.values()))
    def proximity(atoms):
        L = np.array([x for _, _, x in atoms])
        return float(np.min(np.linalg.norm(chain_xyz[:, None, :] - L[None, :, :], axis=2)))
    ranked = sorted(((proximity(v), k, v) for k, v in copies.items()), key=lambda r: r[0])
    dist, which, lig = ranked[0]
    # Drop hydrogens: every distance in this app is a heavy-atom distance.
    lig = [(a, e, x) for a, e, x in lig if e != "H"]
    if len(copies) > 1:
        print(f"    {len(copies)} copies of {t['ligandCode']}; kept chain {which[0]} "
              f"#{which[1]} at {dist:.1f} A from chain {t['complexChain']} "
              f"(next nearest {ranked[1][0]:.1f} A)")
    print(f"    {t['complexPdbId']} chain {t['complexChain']}: {len(xtal_ca)} CA, "
          f"ligand {t['ligandCode']} {len(lig)} heavy atoms")

    # Does the crystal chain actually agree with the AlphaFold sequence? If the numbering
    # were against a different reference this is where it shows up.
    shared = [n for n in xtal_seq if 0 < n <= len(seq)]
    agree = sum(1 for n in shared if seq[n - 1] == xtal_seq[n])
    pct = 100.0 * agree / max(1, len(shared))
    print(f"    crystal vs AlphaFold identity over {len(shared)} shared positions: {pct:.1f}%")
    if pct < 95:
        sys.exit("    crystal chain does not match the AlphaFold sequence. Stopping.")

    # ---- superpose the crystal onto the model, carry the ligand across -------------
    af_ca = ca_from_pdb(af_pdb)
    L = np.array([x for _, _, x in lig])
    near = {r for r, c in xtal_ca.items()
            if np.min(np.linalg.norm(L - np.array(c), axis=1)) < SUPERPOSE_RADIUS}
    common = sorted(near & set(af_ca))
    if len(common) < 60:
        sys.exit(f"    only {len(common)} shared residues near the site; too few to superpose")
    P = np.array([xtal_ca[r] for r in common])
    Q = np.array([af_ca[r] for r in common])
    cp, cq = P.mean(0), Q.mean(0)
    U, S, Vt = np.linalg.svd((P - cp).T @ (Q - cq))
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1, 1, d]) @ U.T
    rmsd = float(np.sqrt((((P - cp) @ R.T + cq - Q) ** 2).sum(1).mean()))
    print(f"    superposed on {len(common)} CA near the site: RMSD {rmsd:.2f} A")

    posed = [(a, e, tuple((np.array(x) - cp) @ R.T + cq)) for a, e, x in lig]
    out_lig = os.path.join(PUBLIC, t["ligandPoseFile"])
    os.makedirs(os.path.dirname(out_lig), exist_ok=True)
    with open(out_lig, "w") as fh:
        fh.write(f"REMARK  {t['ligandCode']} from {t['complexPdbId']} chain {t['complexChain']}, "
                 f"superposed onto AF-{t['uniprotAccession']} "
                 f"(RMSD {rmsd:.2f} A over {len(common)} CA)\n")
        for n, (atom, elem, (x, y, z)) in enumerate(posed, 1):
            nm = atom if len(atom) >= 4 else " " + atom.ljust(3)
            fh.write(f"HETATM{n:5d} {nm}{t['ligandCode']:>4} X   1    "
                     f"{x:8.3f}{y:8.3f}{z:8.3f}  1.00  0.00          {elem:>2}\n")
        fh.write("END\n")

    # ---- pocket: residues within CONTACT_CUTOFF of the ligand, in the crystal ------
    prot = {}
    for f in rows_cif:
        if f[0] != "ATOM" or f[i["auth_asym_id"]] != t["complexChain"]:
            continue
        n = int(f[i["auth_seq_id"]])
        prot.setdefault((n, f[i["auth_comp_id"]]), []).append(
            tuple(float(f[i[k]]) for k in ("Cartn_x", "Cartn_y", "Cartn_z")))
    residues = []
    for (n, comp), ats in sorted(prot.items()):
        dmin = min(np.linalg.norm(np.array(a) - np.array(b)) for a in ats for b in [x for _, _, x in lig])
        if dmin > CONTACT_CUTOFF:
            continue
        residues.append({"uniprotResnum": n, "clinicalResnum": n - offset,
                         "aa": THREE.get(comp, "X"),
                         "minDistanceToLigand": round(float(dmin), 2)})
    print(f"    pocket: {len(residues)} residues within {CONTACT_CUTOFF} A of {t['ligandCode']}")

    # ---- structure file ------------------------------------------------------------
    out_struct = os.path.join(PUBLIC, t["structureFile"])
    os.makedirs(os.path.dirname(out_struct), exist_ok=True)
    if not os.path.exists(out_struct):
        shutil.copyfile(af_pdb, out_struct)
        print(f"    wrote {t['structureFile']}")

    # ---- write the derived JSON ----------------------------------------------------
    json.dump({
        "source": {"pdbId": t["complexPdbId"],
                   "description": f"{t['gene']} residues within {CONTACT_CUTOFF} A of "
                                  f"{t['drug']} ({t['ligandCode']}) in {t['complexPdbId']}",
                   "contactCutoffAngstroms": CONTACT_CUTOFF,
                   "method": f"measured contacts in {t['complexPdbId']} chain {t['complexChain']}, "
                             f"not a curated literature list"},
        "residueCount": len(residues), "residues": residues,
    }, open(os.path.join(PUBLIC, t["pocketFile"]), "w"), indent=2)

    json.dump({
        "catalogue": "CARD (Comprehensive Antibiotic Resistance Database)",
        "sourceFile": "snps.txt", "aro": "ARO:" + t["aro"], "model": "protein variant model",
        "target": t["gene"], "organism": t["organism"], "drug": t["drug"],
        "numbering": f"clinical / WHO - {t['clinicalReference']}; add {offset} for "
                     f"UniProt {t['uniprotAccession']}",
        "note": (f"Substitution-level entries only. {nonsub} nonsense/unspecified/indel records "
                 f"were skipped because they have no single-residue structural equivalent"
                 + (f", and {len(set(dropped))} substitutions were dropped because their "
                    f"wild-type residue disagrees with the structure sequence "
                    f"({', '.join(sorted(set(dropped))[:6])})" if dropped else "") + "."),
        "entryCount": len(kept), "entries": kept,
    }, open(os.path.join(PUBLIC, t["catalogueFile"]), "w"), indent=2)

    print(f"    catalogue: {len(kept)} substitutions over "
          f"{len({e['clinicalResnum'] for e in kept})} residues")
    return {"id": t["id"], "pocket": len(residues), "catalogue": len(kept), "rmsd": round(rmsd, 2)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--card", default="/tmp/card")
    ap.add_argument("--cache", default="/tmp")
    a = ap.parse_args()

    manifest = json.load(open(MANIFEST))["targets"]
    chosen = manifest if a.all else [t for t in manifest if t["id"] == a.target]
    if not chosen:
        sys.exit(f"unknown target. Available: {', '.join(t['id'] for t in manifest)}")
    results = [build(t, a.card, a.cache) for t in chosen]
    print("\n=== summary ===")
    for r in results:
        print(f"  {r['id']:24} pocket={r['pocket']:3}  catalogue={r['catalogue']:4}  "
              f"superposition RMSD={r['rmsd']} A")
