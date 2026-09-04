#!/usr/bin/env node
/**
 * Regenerates public/data/affinity-cache.json from real Boltz-2 NIM runs.
 *
 * The app serves this cache instantly so a demo never waits on a rate-limited cloud GPU.
 * Everything in it must therefore come from an actual run - if this script is ever changed
 * to fabricate or interpolate a number, the panel it feeds becomes a lie.
 *
 * Replicates are the point. Boltz-2's diffusion is stochastic, and repeated runs of the
 * identical wild-type sequence span roughly half a log unit, which is larger than the
 * wild-type-versus-mutant difference being looked for. Arms are interleaved so that any
 * drift in the service lands on both rather than on one.
 *
 * Usage:
 *   NVIDIA_API_KEY=... node scripts/make_affinity_cache.mjs [MUTATION] [REPLICATES]
 *   NVIDIA_API_KEY=... node scripts/make_affinity_cache.mjs S450L 5
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "public/data/affinity-cache.json");
const URL_ = "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict";
const OFFSET = 6; // clinical -> UniProt/structure numbering; see src/lib/targets.ts

const THREE_TO_ONE = {
  ALA:"A",ARG:"R",ASN:"N",ASP:"D",CYS:"C",GLN:"Q",GLU:"E",GLY:"G",HIS:"H",ILE:"I",
  LEU:"L",LYS:"K",MET:"M",PHE:"F",PRO:"P",SER:"S",THR:"T",TRP:"W",TYR:"Y",VAL:"V",
};

const targetId = process.env.TARGET_ID ?? "rpob-rifampicin";
const mutation = (process.argv[2] ?? "S450L").toUpperCase();
const replicates = Number(process.argv[3] ?? 5);
const key = process.env.NVIDIA_API_KEY;
if (!key) {
  console.error("NVIDIA_API_KEY is not set.");
  process.exit(1);
}

const m = /^([A-Z])(\d+)([A-Z])$/.exec(mutation);
if (!m) {
  console.error(`Could not read a substitution from "${mutation}". Use a form like S450L.`);
  process.exit(1);
}
const [, wtAa, resnumRaw, mutAa] = m;
const clinical = Number(resnumRaw);

// Sequence from the same bundled structure the rest of the app measures.
const seq = new Map();
for (const line of readFileSync(path.join(ROOT, "public/hero.pdb"), "utf8").split("\n")) {
  if (line.startsWith("ATOM") && line.slice(12, 16).trim() === "CA") {
    seq.set(Number(line.slice(22, 26)), THREE_TO_ONE[line.slice(17, 20).trim()] ?? "X");
  }
}
const first = Math.min(...seq.keys());
const last = Math.max(...seq.keys());
let wild = "";
for (let i = first; i <= last; i++) wild += seq.get(i) ?? "X";

const index = clinical + OFFSET - first;
if (wild[index] !== wtAa) {
  console.error(`Structure has ${wild[index]} at clinical ${clinical}, not ${wtAa}. Refusing to run.`);
  process.exit(1);
}
const mutant = wild.slice(0, index) + mutAa + wild.slice(index + 1);

const existing = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : null;
const ligand = existing?.ligand;
if (!ligand?.smiles) {
  console.error("No ligand SMILES in the cache to run against; add one before regenerating.");
  process.exit(1);
}

const payload = (sequence) => ({
  polymers: [{ id: "A", molecule_type: "protein", sequence }],
  ligands: [{ id: "RFP", smiles: ligand.smiles, predict_affinity: true }],
  recycling_steps: 3,
  sampling_steps: 50,
  diffusion_samples: 1,
  step_scale: 1.638,
  sampling_steps_affinity: 200,
  diffusion_samples_affinity: 5,
  output_format: "mmcif",
});

async function once(sequence, label, n) {
  const started = Date.now();
  const res = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload(sequence)),
  });
  if (!res.ok) throw new Error(`${label} r${n}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  const a = d.affinities?.RFP ?? {};
  const row = {
    affinityLog10IC50Micromolar: a.affinity_pred_value?.[0],
    bindingProbability: a.affinity_probability_binary?.[0],
    confidence: d.confidence_scores?.[0],
    complexPlddt: d.complex_plddt_scores?.[0],
    ligandIptm: d.ligand_iptm_scores?.[0],
  };
  if (typeof row.affinityLog10IC50Micromolar !== "number") throw new Error(`${label} r${n}: no affinity returned`);
  console.log(`  ${label} r${n}: ${row.affinityLog10IC50Micromolar.toFixed(3)}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  return row;
}

console.log(`${mutation}: ${wild.length} residues, ${replicates} replicates per arm, interleaved.`);
const wildType = [];
const mut = [];
for (let n = 1; n <= replicates; n++) {
  wildType.push(await once(wild, "wt ", n));
  mut.push(await once(mutant, "mut", n));
}

const out = {
  generatedIso: new Date().toISOString(),
  note: existing?.note ?? "Pre-baked from real Boltz-2 NIM runs. Nothing here is synthetic.",
  ligand,
  method: {
    model: "Boltz-2 (mit/boltz2 NIM)",
    endpoint: "health.api.nvidia.com/v1/biology/mit/boltz2/predict",
    sequenceLength: wild.length,
    msa: "none (single sequence)",
    settings:
      "recycling_steps 3, sampling_steps 50, diffusion_samples 1, sampling_steps_affinity 200, " +
      "diffusion_samples_affinity 5. Wild-type and mutant requests interleaved.",
  },
  runs: { ...(existing?.runs ?? {}), [`${targetId}:${mutation}`]: { wildType, mutant: mut } },
};
writeFileSync(CACHE, JSON.stringify(out, null, 2) + "\n");

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const wv = wildType.map((r) => r.affinityLog10IC50Micromolar);
const mv = mut.map((r) => r.affinityLog10IC50Micromolar);
console.log(`\nwild type ${mean(wv).toFixed(3)}   mutant ${mean(mv).toFixed(3)}   delta ${(mean(mv) - mean(wv)).toFixed(3)}`);
console.log(`Wrote ${path.relative(ROOT, CACHE)}`);
