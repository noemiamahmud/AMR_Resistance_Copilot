"""Extract the M. tuberculosis rpoB / rifampicin resistance variants from CARD."""
import csv, json, os, re, sys

CARD_DIR, OUT = sys.argv[1], sys.argv[2]
ARO = "3003283"   # Mtb rpoB mutations conferring resistance to rifampicin

rows = list(csv.DictReader(open(os.path.join(CARD_DIR, "snps.txt")), delimiter="\t"))
mine = [r for r in rows if r["Accession"] == ARO]
assert mine, "no rows for ARO:%s" % ARO

SUB = re.compile(r"^([ACDEFGHIKLMNPQRSTVWY])(\d+)([ACDEFGHIKLMNPQRSTVWY])$")
entries, skipped = [], []
for r in mine:
    muts = [m.strip() for m in r["Mutations"].split(",") if m.strip()]
    parsed = [SUB.match(m) for m in muts]
    if not all(parsed):
        skipped.append(r["Mutations"]); continue      # Ter / Var / indel forms
    for m, p in zip(muts, parsed):
        entries.append({"mutation": m, "wildType": p.group(1),
                        "clinicalResnum": int(p.group(2)), "mutant": p.group(3),
                        "aro": "ARO:" + ARO, "variantType": r["Parameter Type"],
                        "partOfCombination": muts if len(muts) > 1 else None,
                        "evidence": r["source"], "citation": r["citation"]})

best = {}
for e in entries:
    prev = best.get(e["mutation"])
    if prev is None or (prev["partOfCombination"] and not e["partOfCombination"]):
        best[e["mutation"]] = e
out = sorted(best.values(), key=lambda e: (e["clinicalResnum"], e["mutant"]))

json.dump({
  "catalogue": "CARD (Comprehensive Antibiotic Resistance Database)",
  "sourceFile": "snps.txt", "aro": "ARO:" + ARO, "model": "protein variant model",
  "target": "rpoB", "organism": "Mycobacterium tuberculosis", "drug": "rifampicin",
  "numbering": "clinical / WHO - NP_215181.1 (1172 aa); add 6 for UniProt P9WGY9",
  "note": ("Substitution-level entries only. Nonsense (Ter), unspecified (Var) and "
           "indel records are excluded because they have no single-residue structural "
           "equivalent; %d such records were skipped." % len(skipped)),
  "entryCount": len(out), "entries": out}, open(OUT, "w"), indent=2)

print("%d rows -> %d unique substitutions (%d non-substitution records skipped)"
      % (len(mine), len(out), len(skipped)))
