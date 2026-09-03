# AMR Resistance Copilot — Build Plan

## In plain terms

Bacteria constantly evolve to survive the drugs we use to treat infections. When a germ picks up the right tiny change to its DNA, an antibiotic that used to kill it stops working — this is "antibiotic resistance," and it's one of the biggest threats in global health, making once-routine infections like tuberculosis hard or impossible to cure. Today, when labs sequence a patient's infection and spot one of these changes, they check it against a catalogue of known resistance mutations. But that catalogue only lists changes scientists have already seen and studied — so a brand-new change leaves them guessing. This tool fills that gap. It looks at the 3D shape of the germ's protein, sees whether the change lands right where the antibiotic needs to grab hold, and gives a plain, reasoned answer about whether the drug will still work — even for a mutation no one has ever recorded.

**Example:** A public-health lab sequences a tuberculosis sample and finds a mutation in the bacterium that isn't in any database. Normally that's a dead end — is it dangerous or harmless? No one can say. Feed it into this tool, and it pulls up the 3D structure of the targeted protein, shows that the mutation sits exactly where the antibiotic rifampicin normally locks on, and explains that it likely blocks the drug from binding — flagging the sample as probably resistant. That early warning means clinicians can switch the patient to a different treatment sooner, and public-health teams can catch an emerging resistant strain before it spreads.

## Concept

A **structure-grounded mechanistic interpreter for antimicrobial-resistance mutations**. A genomic-surveillance sample from a pathogen shows a mutation in a drug-target protein. Is it resistance-conferring — and *why*?

The system locates the mutation on the target's 3D structure, computes its structural relationship to the drug-binding pocket, and a local LLM reasons over those computed features to produce a **mechanistic resistance hypothesis** with a confidence and a suggested confirmation — then flags whether the mutation is already in the resistance catalogue or **novel**.

**The impact wedge:** resistance-mutation catalogues (CARD, the WHO TB catalogue, ResFinder) are lists of mutations someone has already seen. They say nothing about a mutation that isn't in them — and surveillance turns up novel mutations constantly. That's the same blind spot the best variant-effect models have: they give a verdict without a mechanism and don't generalize to the unseen. This system reasons from *structure*, so it generalizes beyond the catalogue and explains itself — exactly what a surveillance analyst needs to act on a mutation no database recognizes.

**Flagship case:** *Mycobacterium tuberculosis* rpoB + rifampicin — the canonical genomic-AMR-surveillance target, with a WHO-curated mutation catalogue behind it. The textbook mutation rpoB S450L sits in the rifampicin-binding pocket of RNA polymerase.

**Stack:** Next.js / React · **local Qwen3 via Ollama** (function calling + JSON output) · UniProt REST · AlphaFold DB REST · CARD resistance catalogue (bundled) · PubChem (drug SMILES) · 3Dmol.js. Boltz-2 (hosted) is the stretch. No cloud LLM, no API-token cost.

---

## The one rule this plan is built around

> **Every phase ends at a green, demoable checkpoint.** If the clock stops the moment a phase finishes, you have something real to show.

- **Vertical slices, not horizontal layers.** Each phase runs end-to-end.
- **Front-load the wow.** The mutation highlighted in the drug-binding pocket ships in the MVP.
- **Commit at every green checkpoint.** `git commit -m "phase N green"` before touching the next phase.
- **Build the safety net first.** With a local model, the *entire* pipeline — including reasoning — runs offline, so the demo has no network single point of failure.

---

## ⚠️ Grab these yourself (an AI coding agent cannot do these for you)

Do these **before** the clock. Several are multi-GB downloads you don't want to attempt on venue Wi-Fi mid-demo.

- [ ] **Ollama installed + model pulled.** Install Ollama, then `ollama pull qwen3:8b` (do this at home — it's a few GB). This is your LLM; it serves an OpenAI-compatible endpoint at `http://localhost:11434`.
- [ ] **Node.js + npm installed**, with a working `npx create-next-app` scaffold.
- [ ] **Hero structure file, downloaded locally** → `/public/hero.pdb`. Grab the *M. tuberculosis* RpoB AlphaFold model in your browser from `https://alphafold.ebi.ac.uk/files/AF-P9WGY9-F1-model_v4.pdb`. (Confirm the accession on UniProt first; RpoB = `rpoB`, Rv0667.)
- [ ] **Curated drug-pocket residues for the flagship target** → a small JSON of the rifampicin-contact / rifampicin-resistance-determining-region (RRDR) residue numbers for RpoB. Pull these from the literature or a rifampicin–RNAP PDB complex. This is what lets you compute "distance to the drug pocket" without a ligand-bound model.
- [ ] **CARD resistance-mutation data, downloaded once** → from `https://card.mcmaster.ca/download` (includes the WHO/CRyPTIC TB catalogue). Bundle the relevant mutation list locally. Used for the "known vs novel" flag and the eval golden set.
- [ ] **Golden set for the eval, hand-labelled** → ~10 rpoB mutations: 5 known rifampicin-resistance (from CARD/WHO), 5 known-neutral. Curating ground truth is a human call.
- [ ] **(Stretch only) NVIDIA build account + API key** for Boltz-2 at `https://build.nvidia.com/mit/boltz2`.

Everything else — components, fetch logic, the structural computations, the eval harness — an agent can write.

---

## Verified resources (all live)

| Resource | Endpoint / source | Auth | Notes |
|---|---|---|---|
| Local LLM | **Ollama**, OpenAI-compatible at `http://localhost:11434/v1` | none | `qwen3:8b` primary. Apple-Silicon Metal is automatic. Supports tool calling + JSON-schema output. Fully offline → no cost, no rate limits, robust on stage. |
| Gene → UniProt accession | `https://rest.uniprot.org/uniprotkb/search` | none | e.g. `gene:rpoB AND organism_id:83332` (M. tuberculosis H37Rv). |
| AlphaFold structure file | `https://alphafold.ebi.ac.uk/files/AF-{ACC}-F1-model_v4.pdb` | none | pLDDT confidence is in the B-factor column. Meta endpoint field names changed late-2025 — if you use `/api/prediction/{ACC}`, confirm fields at `https://alphafold.ebi.ac.uk/api-doc`. |
| Known resistance mutations | CARD download — `https://card.mcmaster.ca/download` (+ `/latest/variants`) | none | Curated catalogue incl. the TB (WHO/CRyPTIC/ReSeqTB) mutation list. **Download and bundle**; it's your prior-art foil and golden-set source, not a live API. |
| Drug SMILES (for Boltz) | `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/rifampicin/property/CanonicalSMILES/JSON` | none | Only needed for the Boltz stretch. |
| (Stretch) WT-vs-mutant + drug affinity | Boltz-2 NIM — `https://build.nvidia.com/mit/boltz2` | **your key** | Co-folds protein + ligand, returns structure + binding affinity. Hosted, no GPU. Rate-limited. |
| (Optional) Real drug pose | RCSB PDB — experimental rifampicin–RNAP complex | none | If you want the actual ligand shown rather than inferred pocket residues. |
| 3D viewer | 3Dmol.js — `https://3Dmol.org/build/3Dmol-min.js` | none | `viewer.addModel(pdbText, "pdb")`; exposes parsed atom coords for the structural math. |

**Security:** call Boltz (the only cloud service, and only in the stretch) from a Next.js server-side route. The LLM is local, so its "key" is nothing.

---

## The local model on your M2

- **Runner: Ollama.** OpenAI-compatible endpoint means the code is the same shape as a cloud API — just point the base URL at `http://localhost:11434/v1`. Metal acceleration on Apple Silicon is automatic.
- **Model: `qwen3:8b`.** Comfortable on a 16 GB M2, and Qwen3 has the strongest small-model tool-calling reliability, which Phase 4 needs. If you're on an 8 GB M2 or latency feels sluggish, drop to `qwen3:4b`.
- **Demo-latency tips:** keep prompts tight, keep reasoning/"thinking" low for interactive turns, and **pre-warm the model** (one throwaway call) right before you present so the first real response isn't cold. Batch triage (Phase 5) should process a few mutations at a time, not all at once.
- Exact tags shift often — check the current Ollama model page.

---

## Pre-flight (before the demo clock)

- [ ] Next.js scaffold runs, blank page renders.
- [ ] `ollama run qwen3:8b` responds; a test call to `localhost:11434` returns text.
- [ ] 3Dmol.js loading (CDN `<script>` is fastest).
- [ ] `/public/hero.pdb`, the pocket-residues JSON, and the CARD mutation list all present locally.

---

## The demo safety net (build into Phase 1, never skip)

Hardcode a guaranteed path around one hero case:

- **RpoB S450L + rifampicin** (M. tuberculosis) — the textbook rifampicin-resistance mutation, sitting squarely in the drug-binding pocket. Clear story, visible structural reason.
- `/public/hero.pdb` + bundled pocket residues already saved.
- A **"Demo" button** that loads the local structure, jumps to residue 450, and runs the whole offline pipeline (structure → pocket distance → local LLM reasoning).

Wi-Fi, rate limits, a typo — none of it can break the demo, because the hero path touches no network at all.

---

## Phase map

| Phase | Time | Green checkpoint (what you demo) | Signal |
|---|---|---|---|
| **0. Skeleton** | 5 min | App runs, input + empty viewer | — |
| **1. MVP: mutation → structure + pocket distance** | 15 min | Enter rpoB S450L → structure renders, residue highlighted, "in the rifampicin pocket, high-confidence" reported | Load-bearing structure from minute one |
| **2. Mechanistic reasoning (local)** | 10 min | Qwen3 explains the resistance mechanism from the computed features | Grounded local LLM, structured output |
| **3. Beyond-the-catalogue flag** | 5 min | Tool says whether the mutation is known (CARD) or novel — and still calls novel ones | The impact thesis, made visible |
| **4. Computational agent** | 10 min | Tool-call trace over coordinate + catalogue tools | Agentic orchestration, local tool use |
| **5. Surveillance batch triage** | 10 min | Paste a sample's mutation list → ranked, novel-flagged triage table | The real surveillance workflow |
| **6. Separation + generalization eval** | 10 min | Structural score separates resistant vs neutral; catches a "novel" resistance mutation a catalogue lookup misses | Eval engineering + proves the wedge |
| **Stretch. Boltz affinity** | +15 min | WT vs mutant rifampicin binding, predicted live | Quantifies resistance; runs a real model |

Core ≈ 65 min; 5–6 and the stretch are reach. The app is a real demo from Phase 1.

---

## Phase 0 — Skeleton (5 min)

**Goal:** A running page with the input and viewer container every later phase plugs into.

**Build:** One page. Input (target gene + mutation as free text, e.g. "rpoB S450L") + submit on the left; empty `<div id="viewer">` on the right.

**Green checkpoint:** It runs.

---

## Phase 1 — MVP: mutation → structure + pocket distance (15 min) ← *the wow ships here*

**Goal:** Enter a mutation, see the target with that residue highlighted, and report how close it sits to the drug-binding pocket — computed from coordinates.

**Build:**
1. Parse input into gene + residue number (`rpoB`, `450`).
2. **Gene → accession** (UniProt REST), or just use the bundled flagship accession for the MVP.
3. **Fetch structure**: build the `files/AF-{ACC}-F1-model_v4.pdb` URL, pull the PDB text (hero file offline as fallback).
4. **Render** in 3Dmol.js; **highlight the mutated residue** and **color the bundled pocket residues** so the drug site is visible.
5. **Compute the key structural fact**: minimum distance from the mutated residue's Cα to any pocket residue (a few lines over parsed atoms), plus **pLDDT at the residue** (B-factor). Small distance = sits in the pocket.
6. **Wire the hero button** (safety net) here.

**Green checkpoint / demo:** *"I enter rpoB S450L — here's RNA polymerase, that's the mutated residue in red, and it's 3 Å from the rifampicin-binding pocket in a high-confidence region. Structurally, this is exactly where a resistance mutation would sit."* You're computing, not just rendering.

**Fallback:** If UniProt/AFDB is flaky, run via the hero button.

---

## Phase 2 — Mechanistic reasoning (10 min)

**Goal:** Turn the computed features into a resistance mechanism hypothesis, grounded in those features.

**Build:** Send Qwen3 (local) a **structured payload**: residue, wild-type/mutant amino acid, distance-to-pocket, pLDDT, burial. Request a **JSON-schema** response: `mechanismHypothesis`, `resistanceLikelihood`, `confidenceCaveat`, `whatWouldConfirm`. Prompt constraint: *reason only from the provided structural features; do not assert facts they don't support.* Write the output for a clinical-microbiology / surveillance-analyst reader.

**Green checkpoint / demo:** *"Qwen3 reasons over those numbers — in the pocket, high-confidence, hydrophilic→hydrophobic swap — to propose that it weakens rifampicin binding while sparing polymerase function, and it flags what would confirm it."* Local, grounded, offline.

**Fallback:** Plain text if JSON is shaky.

---

## Phase 3 — Beyond-the-catalogue flag (5 min)

**Goal:** Make the impact thesis visible in one move.

**Build:** Look the mutation up in the bundled CARD/WHO list. If it's there, show the catalogue entry. If it **isn't**, foreground that — *"this mutation is not in the resistance catalogue"* — and still deliver the structural call from Phase 2.

**Green checkpoint / demo:** *"A catalogue lookup would return nothing for this novel mutation — but structure lets us make a mechanistic call anyway. That's the whole point: surveillance finds mutations no database has yet."*

**Fallback:** None needed; it's a lookup + a banner.

---

## Phase 4 — Computational agent (10 min)

**Goal:** Expose the computations as tools and let Qwen3 orchestrate them, showing its work.

**Build:** Define **tools**: `distance_to_pocket(residue)`, `pLDDT_at(residue)`, `neighbors_within(residue, radius)`, `catalogue_lookup(mutation)`. Let the model choose the call sequence via Ollama tool-calling, then **render the trace** — each call, its args, its return. The model can't answer without measuring the structure.

**Green checkpoint / demo:** *"Under the hood, Qwen3 is orchestrating tools that measure the structure and query the catalogue — here's the exact trace."* The trace is also your reasoning-transparency story.

**Fallback:** Keep the Phase-1 deterministic pipeline behind a flag.

---

## Phase 5 — Surveillance batch triage (10 min, stretch)

**Goal:** The actual surveillance workflow — a sample isn't one mutation, it's a list.

**Build:** Paste a set of mutations (a "surveillance isolate"). Run each through the pipeline, produce a **ranked triage table**: resistance likelihood, in-pocket distance, known-vs-novel flag. Sort so the analyst sees the high-risk novel ones first. (Process a few at a time to keep the local model responsive.)

**Green checkpoint / demo:** *"Here's a whole isolate's mutations, ranked — and the one at the top is a novel pocket mutation the catalogue would have missed."*

**Fallback:** Skip; single-variant flow is complete on its own.

---

## Phase 6 — Separation + generalization eval (10 min)

**Goal:** Prove the structural signal works — and prove the wedge.

**Build:** Two small evals on your golden set:
1. **Separation** — does the structural score (in-pocket + high-pLDDT + burial) split the 5 known-resistant from the 5 neutral? Show the split / a threshold / an accuracy number.
2. **Generalization** — take a known resistance mutation, **hide it from the catalogue** ("pretend novel"), and show your tool still flags it correctly while a pure catalogue lookup returns nothing. This is the money result: it directly demonstrates generalizing beyond the catalogue.

**Green checkpoint / demo:** *"The structural score separates resistant from neutral here, and — critically — when I treat a known resistance mutation as novel, the catalogue misses it and structure still catches it."*

**Fallback:** Even 6 mutations in a printed table counts. Have the numbers ready to say aloud.

---

## Stretch — Boltz-2 affinity (+15 min, only if earlier phases flew)

**Goal:** Quantify the resistance instead of inferring it.

**Why it lands:** with the drug's SMILES (PubChem) and the target sequence, Boltz-2 co-folds protein + ligand and predicts binding affinity. Run it for **wild-type vs mutant** and show the affinity drop — a live, quantitative resistance readout no catalogue can give.

**Build:** From a server route, send WT and mutant sequences + rifampicin SMILES to the Boltz-2 NIM; compare predicted affinities; render the delta.

**Non-negotiable fence:** cold predictions are slow and rate-limited. **Pre-bake a cached WT-vs-mutant result** so the demo never blocks — show live if it returns in time, fall back to cached instantly.

---

## If you get cut off early — triage

- **~20 min:** Phase 1 done. Mutation in the pocket, distance computed. Load-bearing, on-theme.
- **~35 min:** Phases 1–3. Structure + mechanism + the beyond-the-catalogue beat. This already tells the whole impact story.
- **~50 min:** Phases 1–4. Add the agent trace. Reads as an AI-Engineering project.
- **Full hour:** Reach into 5 or 6 — **6 (eval)** for rigor and the wedge, **5 (batch triage)** for the surveillance-workflow wow. Boltz only if everything else is solid.

---

## Interview-narrative map

- **Phase 1–2** → "I built a tool that computes structural evidence and grounds a *local* LLM in it — no black-box score, an auditable mechanism."
- **Phase 3** → "It generalizes past resistance catalogues, which can't interpret a mutation they've never seen."
- **Phase 4** → "I designed it as an agent orchestrating tools that measure 3D structure, with a transparent trace — running entirely on a local open-weight model."
- **Phase 5** → "It runs the real surveillance workflow: rank a sample's mutations, surface novel high-risk ones."
- **Phase 6** → "I proved the wedge with an eval: when a known resistance mutation is treated as novel, the catalogue misses it and structure catches it."
- **Stretch** → "I quantified the resistance by co-folding target + drug and comparing wild-type vs mutant affinity."

---

## Quick reference — endpoints & libs

- **Local LLM:** Ollama, `http://localhost:11434/v1` (OpenAI-compatible), model `qwen3:8b` (`qwen3:4b` if tight); tool calling + JSON output.
- **UniProt search:** `https://rest.uniprot.org/uniprotkb/search?query=gene:rpoB+AND+organism_id:83332&fields=accession&format=json`
- **AlphaFold PDB file:** `https://alphafold.ebi.ac.uk/files/AF-{ACC}-F1-model_v4.pdb` (pLDDT = B-factor)
- **CARD download:** `https://card.mcmaster.ca/download` (bundle the mutation list / TB catalogue locally)
- **PubChem SMILES:** `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{drug}/property/CanonicalSMILES/JSON`
- **3D viewer:** 3Dmol.js — `https://3Dmol.org/build/3Dmol-min.js`
- **Boltz-2 (stretch):** `https://build.nvidia.com/mit/boltz2`

---

## Honest risks to watch

- **Pocket distance uses curated contact residues, not true docking** — a defensible approximation for a demo; the Boltz stretch is what turns it quantitative. Don't overclaim it as measured binding.
- **Local-model latency on M2** — keep the model small, thinking low, prompts tight, and pre-warm before presenting.
- **AFDB monomer lacks the drug** — the pocket is inferred from known residues (or an experimental complex / Boltz). Say so.
- **Not a diagnostic** — this is a surveillance triage and hypothesis aid. That framing is also the mature one.
- **CARD/WHO catalogues are prior art** — cite them and position clearly as the thing you *generalize beyond*, not something you replace.

---

*Make the structure load-bearing. Generalize beyond the catalogue. Build the safety net first.*