/**
 * Stretch - the Boltz-2 client.
 *
 * The only cloud service this project touches, and the only one with a key, so it lives
 * server-side and nothing here is ever imported by a client component. Everything else in
 * the app runs from bundled files and a model on the same machine; this is the exception,
 * and it is deliberately optional - with no key configured the app is exactly as it was.
 *
 * Boltz-2 co-folds the protein with the ligand and predicts an affinity, which is a
 * different kind of claim from the rest of the app: the structural pipeline measures a
 * geometry that already exists, while this predicts a quantity. Read lib/affinity.ts for
 * what that difference costs.
 */

export const BOLTZ_URL = "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict";

/** The NIM's documented ceiling is 4096 residues per chain; rpoB is 1178. */
export const MAX_CHAIN_RESIDUES = 4096;

export class BoltzUnavailableError extends Error {}
export class BoltzNotConfiguredError extends Error {}

export function boltzConfigured(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY);
}

export interface BoltzPrediction {
  /**
   * log10(IC50) with IC50 in micromolar, which is Boltz-2's own scale.
   * LOWER IS TIGHTER BINDING: -3 is roughly nanomolar, 0 micromolar, +2 a decoy.
   */
  affinityLog10IC50Micromolar: number;
  /** Probability the ligand binds at all, 0-1. A different head, trained differently. */
  bindingProbability: number;
  /** How much to trust the co-folded complex the affinity was read off. */
  confidence: number;
  complexPlddt: number;
  ligandIptm: number;
  serverSeconds: number;
  wallMs: number;
}

export interface BoltzOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface BoltzResponse {
  affinities?: Record<
    string,
    { affinity_pred_value?: number[]; affinity_probability_binary?: number[] }
  >;
  confidence_scores?: number[];
  complex_plddt_scores?: number[];
  ligand_iptm_scores?: number[];
  metrics?: { total_time_seconds?: number };
}

const LIGAND_ID = "RFP";

/**
 * Request settings. `diffusion_samples_affinity` ensembles five affinity reads off one
 * co-folded structure; it does not average over structures, which is why lib/affinity.ts
 * repeats the whole request rather than trusting a single call.
 */
export function boltzPayload(sequence: string, smiles: string) {
  return {
    polymers: [{ id: "A", molecule_type: "protein", sequence }],
    ligands: [{ id: LIGAND_ID, smiles, predict_affinity: true }],
    recycling_steps: 3,
    sampling_steps: 50,
    diffusion_samples: 1,
    step_scale: 1.638,
    sampling_steps_affinity: 200,
    diffusion_samples_affinity: 5,
    output_format: "mmcif",
  };
}

export async function predictAffinity(
  sequence: string,
  smiles: string,
  options: BoltzOptions = {},
): Promise<BoltzPrediction> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) {
    throw new BoltzNotConfiguredError(
      "NVIDIA_API_KEY is not set, so no live affinity prediction can be run.",
    );
  }
  if (sequence.length > MAX_CHAIN_RESIDUES) {
    throw new BoltzUnavailableError(
      `Sequence is ${sequence.length} residues; the NIM accepts at most ${MAX_CHAIN_RESIDUES} per chain.`,
    );
  }

  const { timeoutMs = 180_000 } = options;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(BOLTZ_URL, {
      method: "POST",
      headers: {
        // The key goes to NVIDIA and nowhere else, and never reaches the browser.
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.any(signals),
      body: JSON.stringify(boltzPayload(sequence, smiles)),
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new BoltzUnavailableError(
      err instanceof Error && err.name === "TimeoutError"
        ? `Boltz-2 did not answer within ${Math.round(timeoutMs / 1000)}s.`
        : "Could not reach the Boltz-2 NIM.",
    );
  }

  if (!response.ok) {
    // Never echo the body wholesale - it is a third-party response going into our UI.
    const detail = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new BoltzUnavailableError(
      response.status === 401 || response.status === 403
        ? "Boltz-2 rejected the API key."
        : response.status === 429
          ? "Boltz-2 is rate-limiting this key. The cached comparison is shown instead."
          : `Boltz-2 returned ${response.status}. ${detail}`,
    );
  }

  const body = (await response.json()) as BoltzResponse;
  const affinity = body.affinities?.[LIGAND_ID];
  const value = affinity?.affinity_pred_value?.[0];
  const probability = affinity?.affinity_probability_binary?.[0];
  if (typeof value !== "number" || typeof probability !== "number") {
    throw new BoltzUnavailableError("Boltz-2 returned no affinity for the ligand.");
  }

  return {
    affinityLog10IC50Micromolar: value,
    bindingProbability: probability,
    confidence: body.confidence_scores?.[0] ?? 0,
    complexPlddt: body.complex_plddt_scores?.[0] ?? 0,
    ligandIptm: body.ligand_iptm_scores?.[0] ?? 0,
    serverSeconds: body.metrics?.total_time_seconds ?? 0,
    wallMs: Date.now() - started,
  };
}
