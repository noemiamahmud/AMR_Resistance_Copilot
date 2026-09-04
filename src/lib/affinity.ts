/**
 * Stretch - wild type versus mutant rifampicin affinity, with an error bar.
 *
 * The rest of the app measures a structure that already exists. This predicts a quantity,
 * which is a much stronger kind of claim, so it is held to a correspondingly higher bar:
 *
 *  1. Boltz-2's diffusion is stochastic. Two identical requests for the same wild-type
 *     sequence came back 0.6 log units apart, which is larger than most resistance effects
 *     anyone would want to report. A single wild-type-versus-mutant pair is therefore not
 *     evidence of anything, and this module never renders one. Every arm is repeated and
 *     the difference is reported against the spread of the repeats.
 *  2. The comparison is cached from a real run and served instantly, so a demo never waits
 *     on a rate-limited cloud service. Live re-runs are opt-in and fall back to the cache.
 *
 * Direction of travel: affinity is log10(IC50) in micromolar and LOWER IS TIGHTER, so
 * resistance predicts the mutant sitting HIGHER than the wild type.
 */

import { promises as fs } from "fs";
import path from "path";

import { AnalysisError, loadAssets } from "./analysis";
import { THREE_TO_ONE } from "./aminoAcids";
import { BoltzPrediction, boltzConfigured, predictAffinity } from "./boltz";
import { parseMutation } from "./mutation";
import { sequenceOf } from "./pdb";
import { RPOB_RIFAMPICIN, TargetDefinition, clinicalToUniprot } from "./targets";

/** A difference this many standard errors clear of zero is worth calling a difference. */
export const NOISE_THRESHOLD_SE = 2;

export interface AffinityReplicate {
  affinityLog10IC50Micromolar: number;
  bindingProbability: number;
  confidence: number;
  complexPlddt: number;
  ligandIptm: number;
}

export interface AffinityArm {
  label: string;
  n: number;
  affinityMean: number;
  affinitySd: number;
  bindingProbabilityMean: number;
  confidenceMean: number;
  complexPlddtMean: number;
  ligandIptmMean: number;
  values: number[];
}

export interface AffinityComparison {
  mutation: string;
  source: "cached" | "live";
  generatedIso: string | null;
  ligand: { name: string; smiles: string; source: string };
  method: {
    model: string;
    endpoint: string;
    sequenceLength: number;
    msa: string;
    settings: string;
  };
  wildType: AffinityArm;
  mutant: AffinityArm;
  /** mutant minus wild type. Positive means weaker predicted binding, i.e. resistance. */
  deltaLog10: number;
  standardError: number;
  /** |delta| expressed in standard errors. */
  separationSe: number;
  clearsNoise: boolean;
  direction: "weaker in the mutant" | "tighter in the mutant" | "no resolvable difference";
  /** 10^delta - how many times weaker the mutant binds, if the delta is real. */
  foldChange: number;
  /**
   * What every possible single wild-type/mutant pairing of these replicates would have
   * concluded. This is the argument for replicating at all: if the extremes of this range
   * disagree about the direction, then one run of each proves nothing.
   */
  singlePair: {
    pairs: number;
    minDeltaLog10: number;
    maxDeltaLog10: number;
    inResistanceDirection: number;
  };
  verdict: string;
  caveats: string[];
}

interface CacheFile {
  generatedIso: string;
  ligand: AffinityComparison["ligand"];
  method: AffinityComparison["method"];
  runs: Record<string, { wildType: AffinityReplicate[]; mutant: AffinityReplicate[] }>;
}

const CACHE_FILE = "data/affinity-cache.json";

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation; 0 for a single replicate, which is the honest answer. */
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function arm(label: string, replicates: AffinityReplicate[]): AffinityArm {
  const values = replicates.map((r) => r.affinityLog10IC50Micromolar);
  return {
    label,
    n: replicates.length,
    affinityMean: +mean(values).toFixed(3),
    affinitySd: +sd(values).toFixed(3),
    bindingProbabilityMean: +mean(replicates.map((r) => r.bindingProbability)).toFixed(3),
    confidenceMean: +mean(replicates.map((r) => r.confidence)).toFixed(3),
    complexPlddtMean: +mean(replicates.map((r) => r.complexPlddt)).toFixed(3),
    ligandIptmMean: +mean(replicates.map((r) => r.ligandIptm)).toFixed(3),
    values: values.map((v) => +v.toFixed(3)),
  };
}

function compare(
  mutation: string,
  source: "cached" | "live",
  generatedIso: string | null,
  ligand: AffinityComparison["ligand"],
  method: AffinityComparison["method"],
  wtReps: AffinityReplicate[],
  mutReps: AffinityReplicate[],
): AffinityComparison {
  const wildType = arm("wild type", wtReps);
  const mutant = arm("mutant", mutReps);

  // Every pairing of one wild-type run with one mutant run, which is what a single
  // wild-type-versus-mutant experiment would have sampled from.
  const pairDeltas: number[] = [];
  for (const w of wildType.values) for (const m of mutant.values) pairDeltas.push(m - w);
  const singlePair = {
    pairs: pairDeltas.length,
    minDeltaLog10: +Math.min(...pairDeltas).toFixed(3),
    maxDeltaLog10: +Math.max(...pairDeltas).toFixed(3),
    inResistanceDirection: pairDeltas.filter((d) => d > 0).length,
  };

  const delta = mutant.affinityMean - wildType.affinityMean;
  // Welch: each arm contributes its own variance, since there is no reason to assume
  // the mutant is as reproducible as the wild type.
  const se = Math.sqrt(
    (wildType.affinitySd ** 2) / Math.max(1, wildType.n) +
      (mutant.affinitySd ** 2) / Math.max(1, mutant.n),
  );
  const replicated = wildType.n > 1 && mutant.n > 1;
  const separation = se > 0 ? Math.abs(delta) / se : 0;
  const clears = replicated && se > 0 && separation >= NOISE_THRESHOLD_SE;

  const direction: AffinityComparison["direction"] = !clears
    ? "no resolvable difference"
    : delta > 0
      ? "weaker in the mutant"
      : "tighter in the mutant";

  // With one run per arm there is no spread to test against, and saying "0.0 standard
  // errors" would dress that up as a result. Say instead that the run cannot answer.
  const verdict = !replicated
    ? `One run per arm, so there is nothing to test this against. The two differ by ${delta > 0 ? "+" : ""}${delta.toFixed(2)} log10 IC50, but repeated wild-type runs of this same sequence span half a log unit on their own, so a single pair carries no information about the mutation. Re-run with replicates.`
    : clears
      ? delta > 0
        ? `The mutant binds ${(10 ** delta).toFixed(1)}× more weakly than the wild type (+${delta.toFixed(2)} log10 IC50, ${separation.toFixed(1)} standard errors). That is the direction resistance predicts.`
        : `The mutant is predicted to bind ${(10 ** -delta).toFixed(1)}× more tightly (${delta.toFixed(2)} log10 IC50, ${separation.toFixed(1)} standard errors) — the opposite of what resistance predicts.`
      : `No resolvable difference. The wild-type and mutant means differ by ${delta.toFixed(2)} log10 IC50, which is only ${separation.toFixed(1)} standard errors given a run-to-run spread of ±${Math.max(wildType.affinitySd, mutant.affinitySd).toFixed(2)}. On this evidence Boltz-2 does not separate the two.`;

  return {
    mutation,
    source,
    generatedIso,
    ligand,
    method,
    wildType,
    mutant,
    deltaLog10: +delta.toFixed(3),
    standardError: +se.toFixed(3),
    separationSe: +separation.toFixed(2),
    clearsNoise: clears,
    direction,
    foldChange: +(10 ** delta).toFixed(2),
    singlePair,
    verdict,
    caveats: [
      `A single wild-type/mutant pair drawn from these runs would have reported anything between ${singlePair.minDeltaLog10.toFixed(2)} and +${singlePair.maxDeltaLog10.toFixed(2)} log10 IC50, and ${singlePair.inResistanceDirection} of ${singlePair.pairs} pairings point the way resistance predicts while the other ${singlePair.pairs - singlePair.inResistanceDirection} point the opposite way. That is why this panel never shows one run of each.`,
      `Run without a multiple-sequence alignment. Co-folding a ${method.sequenceLength}-residue chain from a single sequence gives a low-confidence complex (pLDDT ${wildType.complexPlddtMean} wild type, ${mutant.complexPlddtMean} mutant), and the affinity is read off that complex.`,
      "The structure modelled is the isolated rpoB subunit. Rifampicin binds the assembled RNA polymerase holoenzyme, and the pocket is completed by parts of the complex that are not in this prediction.",
      "Boltz-2's affinity head is trained for hit discovery on drug-like ligands, which is a different task from resolving a single-residue effect on a known binder.",
      "This is a predicted quantity, not a measurement. The rest of the app measures a geometry that exists; this does not.",
    ],
  };
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "public", CACHE_FILE), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

/** The wild-type and mutant sequences, taken from the same structure everything else uses. */
export async function sequencesFor(
  target: TargetDefinition,
  clinicalResnum: number,
  mutantAa: string,
): Promise<{ wildType: string; mutant: string; wildTypeAa: string }> {
  const assets = await loadAssets(target);
  const { sequence, firstResSeq } = sequenceOf(assets.structure, THREE_TO_ONE);
  const index = clinicalToUniprot(target, clinicalResnum) - firstResSeq;
  if (index < 0 || index >= sequence.length) {
    throw new AnalysisError(`Residue ${clinicalResnum} is outside the modelled sequence.`);
  }
  return {
    wildType: sequence,
    mutant: sequence.slice(0, index) + mutantAa + sequence.slice(index + 1),
    wildTypeAa: sequence[index],
  };
}

export interface AffinityOptions {
  /** Run the model now instead of serving the cached comparison. */
  live?: boolean;
  /** Replicates per arm when running live. */
  replicates?: number;
  signal?: AbortSignal;
}

export interface AffinityResult {
  comparison: AffinityComparison | null;
  /** Why there is nothing to show, when there is nothing to show. */
  unavailable: string | null;
  /** Set when a live run was asked for and the cache was served instead. */
  fellBackTo: string | null;
  liveAvailable: boolean;
}

export async function affinityFor(
  input: string,
  options: AffinityOptions = {},
): Promise<AffinityResult> {
  const parsed = parseMutation(input);
  const target = RPOB_RIFAMPICIN;
  const cache = await readCache();
  const cached = cache?.runs[parsed.canonical] ?? null;

  const cachedComparison = cache && cached
    ? compare(parsed.canonical, "cached", cache.generatedIso, cache.ligand, cache.method,
        cached.wildType, cached.mutant)
    : null;

  if (!options.live) {
    return {
      comparison: cachedComparison,
      unavailable: cachedComparison
        ? null
        : `No cached Boltz-2 comparison for ${parsed.canonical}. Only ${Object.keys(cache?.runs ?? {}).join(", ") || "nothing"} is pre-baked; run it live to predict a new one.`,
      fellBackTo: null,
      liveAvailable: boltzConfigured(),
    };
  }

  if (!boltzConfigured()) {
    return {
      comparison: cachedComparison,
      unavailable: cachedComparison ? null : "NVIDIA_API_KEY is not set, so no live run is possible.",
      fellBackTo: cachedComparison ? "NVIDIA_API_KEY is not set, so the cached comparison is shown." : null,
      liveAvailable: false,
    };
  }

  const replicates = Math.max(1, Math.min(5, options.replicates ?? 3));
  const { wildType, mutant } = await sequencesFor(target, parsed.clinicalResnum, parsed.mutant);
  const ligand = cache?.ligand ?? {
    name: target.drug,
    smiles: "",
    source: "RCSB chemical component RFP",
  };
  if (!ligand.smiles) {
    return {
      comparison: cachedComparison,
      unavailable: cachedComparison ? null : "No ligand SMILES is bundled, so no live run is possible.",
      fellBackTo: cachedComparison ? "No ligand SMILES is bundled; the cached comparison is shown." : null,
      liveAvailable: false,
    };
  }

  const wtReps: AffinityReplicate[] = [];
  const mutReps: AffinityReplicate[] = [];
  const keep = (p: BoltzPrediction): AffinityReplicate => ({
    affinityLog10IC50Micromolar: p.affinityLog10IC50Micromolar,
    bindingProbability: p.bindingProbability,
    confidence: p.confidence,
    complexPlddt: p.complexPlddt,
    ligandIptm: p.ligandIptm,
  });

  try {
    // Interleaved, so any drift in the service lands on both arms rather than one.
    for (let i = 0; i < replicates; i++) {
      wtReps.push(keep(await predictAffinity(wildType, ligand.smiles, { signal: options.signal })));
      mutReps.push(keep(await predictAffinity(mutant, ligand.smiles, { signal: options.signal })));
    }
  } catch (err) {
    if (options.signal?.aborted) throw err;
    const why = err instanceof Error ? err.message : "The live run failed.";
    return {
      comparison: cachedComparison,
      unavailable: cachedComparison ? null : why,
      fellBackTo: cachedComparison ? `${why} The cached comparison is shown instead.` : null,
      liveAvailable: true,
    };
  }

  return {
    comparison: compare(
      parsed.canonical, "live", new Date().toISOString(),
      ligand,
      { ...(cache?.method ?? { model: "boltz2", endpoint: "NVIDIA NIM", msa: "none (single sequence)", settings: "" }), sequenceLength: wildType.length },
      wtReps, mutReps,
    ),
    unavailable: null,
    fellBackTo: null,
    liveAvailable: true,
  };
}
