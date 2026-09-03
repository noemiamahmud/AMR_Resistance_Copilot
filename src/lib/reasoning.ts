/**
 * Phase 2 - mechanistic reasoning.
 *
 * The structural analysis produces numbers. This module hands those numbers, and
 * nothing else, to a local qwen3 and asks for a mechanism.
 *
 * Two constraints are load-bearing:
 *
 *  1. The payload is *only* measurements. In particular the catalogue verdict is
 *     deliberately withheld, so the model cannot answer "S450L is the textbook
 *     rifampicin-resistance mutation" from memory and call it reasoning. Whatever it
 *     says has to come from the geometry - which is exactly what has to be true for
 *     the beyond-the-catalogue claim in the later phases to mean anything.
 *  2. The output is schema-constrained, so the UI can render fields rather than prose,
 *     and so a downstream phase can rank on `resistanceLikelihood`.
 */

import type { AnalysisResult } from "./analysis";
import { OllamaUnavailableError, chat, ollamaModel } from "./ollama";

export type ResistanceLikelihood = "high" | "moderate" | "low" | "uncertain";

export const LIKELIHOODS: ResistanceLikelihood[] = ["high", "moderate", "low", "uncertain"];

/** Exactly what the model is shown. Surfaced in the response so the demo can prove it. */
export interface ReasoningFeatures {
  target: { gene: string; organism: string; protein: string; drug: string };
  mutation: {
    canonical: string;
    clinicalPosition: number;
    structurePosition: number;
    wildType: string;
    mutant: string;
    change: string;
    hydropathyShift: number;
    sideChainVolumeShiftCubicAngstroms: number;
    chargeShift: number;
  };
  measurements: {
    minDistanceToDrugAngstroms: number;
    alphaCarbonDistanceToDrugAngstroms: number;
    proximityBand: string;
    isKnownDrugContactResidue: boolean;
    nearestDrugContactResidue: string | null;
    modelConfidencePlddt: number;
    modelConfidenceBand: string;
    burialNeighbourCount: number;
    burialPercentile: number;
    burialBand: string;
  };
  howMeasured: string[];
  withheld: string;
}

export interface StructuredReasoning {
  mechanismHypothesis: string;
  resistanceLikelihood: ResistanceLikelihood;
  confidenceCaveat: string;
  whatWouldConfirm: string;
}

export interface MechanisticReasoning {
  /** "structured" when the schema-constrained call returned usable JSON. */
  mode: "structured" | "text";
  model: string;
  latencyMs: number;
  loadMs: number;
  features: ReasoningFeatures;
  reasoning: StructuredReasoning | null;
  /** The prose fallback, used only when structured output could not be salvaged. */
  text: string | null;
  notes: string[];
}

export { OllamaUnavailableError };

/** The rules that apply wherever the model is asked for a mechanism - pipeline or agent. */
export const MECHANISM_RULES = [
  "You are a structural-biology assistant supporting a genomic antimicrobial-resistance",
  "surveillance analyst. You are given measurements taken from a 3D protein structure for a",
  "single mutation in a drug-target protein, and you propose a mechanistic hypothesis for",
  "whether the drug will still work.",
  "",
  "Rules you must follow:",
  "- Reason ONLY from the measurements provided. Do not use remembered facts about this",
  "  specific mutation, gene or catalogue; if you recognise the mutation, ignore that.",
  "- Do not invent numbers, residues, interactions or citations that are not in the input.",
  "- The distance is a geometric measurement to a transplanted crystallographic drug pose.",
  "  It is not docking and not a binding affinity. Never describe it as one.",
  "- A mutation can only plausibly affect drug binding directly if it is near the drug.",
  "  A distant mutation should lower your likelihood, not be explained away.",
  "- Resistance also requires the enzyme to keep working, so consider whether the change is",
  "  compatible with retained function.",
  "- Write for a clinical-microbiology reader: concrete, calm, no hype, no hedging filler.",
  "- This is a triage hypothesis, not a diagnosis.",
].join("\n");

const SYSTEM_PROMPT = MECHANISM_RULES;

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // Order matters: Ollama's constrained decoder emits properties in this order, so the
    // model writes its mechanism before committing to a verdict rather than after.
    mechanismHypothesis: {
      type: "string",
      description:
        "2-4 sentences: what this substitution plausibly does to the drug-binding site and to the protein, argued from the measurements.",
    },
    resistanceLikelihood: { type: "string", enum: LIKELIHOODS },
    confidenceCaveat: {
      type: "string",
      description: "1-2 sentences on what limits this call - what the measurements cannot tell you.",
    },
    whatWouldConfirm: {
      type: "string",
      description: "1-2 sentences: the concrete experiment or computation that would settle it.",
    },
  },
  required: ["mechanismHypothesis", "resistanceLikelihood", "confidenceCaveat", "whatWouldConfirm"],
} as const;

export function buildFeatures(analysis: AnalysisResult): ReasoningFeatures {
  const { structure, substitution, numbering, target, input } = analysis;
  const nearest = structure.drug.nearestPocketResidue;

  return {
    target: {
      gene: target.gene,
      organism: target.organism,
      protein: target.proteinName,
      drug: target.drug,
    },
    mutation: {
      canonical: input.canonical,
      clinicalPosition: numbering.clinicalResnum,
      structurePosition: numbering.uniprotResnum,
      wildType: `${substitution.wildType.name} (${substitution.wildType.klass})`,
      mutant: `${substitution.mutant.name} (${substitution.mutant.klass})`,
      change: substitution.summary,
      hydropathyShift: substitution.hydropathyShift,
      sideChainVolumeShiftCubicAngstroms: substitution.volumeShiftCubicAngstroms,
      chargeShift: substitution.chargeShift,
    },
    measurements: {
      minDistanceToDrugAngstroms: structure.drug.minDistanceToDrugAngstroms,
      alphaCarbonDistanceToDrugAngstroms: structure.drug.caDistanceToDrugAngstroms,
      proximityBand: structure.drug.proximity,
      isKnownDrugContactResidue: structure.drug.isPocketResidue,
      nearestDrugContactResidue: nearest
        ? `${nearest.aa}${nearest.clinicalResnum} at ${nearest.distanceAngstroms} A`
        : null,
      modelConfidencePlddt: structure.confidence.plddt,
      modelConfidenceBand: structure.confidence.band,
      burialNeighbourCount: structure.burial.neighborCount,
      burialPercentile: structure.burial.percentile,
      burialBand: structure.burial.band,
    },
    howMeasured: [
      `Distances are minimum heavy-atom distances to the ${target.drug} pose from ${analysis.pocket.pdbId}, superposed onto the ${target.uniprotAccession} model. Geometry, not docking.`,
      "Model confidence is AlphaFold pLDDT at this residue (0-100); it says how trustworthy the local coordinates are, nothing about resistance.",
      `Burial is a neighbour count within 10 A, given as a percentile against every residue of this structure (100 = most buried).`,
      `The drug-contact set is every residue within ${analysis.pocket.contactCutoffAngstroms} A of the drug in the experimental complex.`,
    ],
    withheld:
      "Catalogue status is intentionally not provided. Do not guess it; reason from the structure alone.",
  };
}

function userPrompt(features: ReasoningFeatures): string {
  return [
    "Structural measurements for one mutation:",
    "",
    JSON.stringify(features, null, 2),
    "",
    "Propose the mechanistic hypothesis. Keep every field short and specific.",
  ].join("\n");
}

/** Pull an object out of a response that may be fenced or prefixed with chatter. */
function extractJson(raw: string): unknown | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function coerce(value: unknown): { reasoning: StructuredReasoning | null; notes: string[] } {
  if (typeof value !== "object" || value === null) {
    return { reasoning: null, notes: ["model output was not a JSON object"] };
  }
  const obj = value as Record<string, unknown>;
  const notes: string[] = [];

  const str = (key: keyof StructuredReasoning): string => {
    const v = obj[key];
    return typeof v === "string" ? v.trim() : "";
  };

  const mechanismHypothesis = str("mechanismHypothesis");
  if (!mechanismHypothesis) {
    return { reasoning: null, notes: ["model output had no mechanism hypothesis"] };
  }

  const rawLikelihood = String(obj.resistanceLikelihood ?? "").toLowerCase().trim();
  const likelihood = LIKELIHOODS.find((l) => l === rawLikelihood);
  if (!likelihood) {
    notes.push(`likelihood "${obj.resistanceLikelihood}" was not one of the allowed values; recorded as uncertain`);
  }

  return {
    reasoning: {
      mechanismHypothesis,
      resistanceLikelihood: likelihood ?? "uncertain",
      confidenceCaveat: str("confidenceCaveat") || "The model did not state a caveat.",
      whatWouldConfirm: str("whatWouldConfirm") || "The model did not propose a confirmation.",
    },
    notes,
  };
}

/** Salvage a StructuredReasoning out of whatever the model returned. */
export function parseStructuredReasoning(raw: string): {
  reasoning: StructuredReasoning | null;
  notes: string[];
} {
  const parsed = extractJson(raw);
  if (parsed === null) return { reasoning: null, notes: ["model output was not parseable JSON"] };
  return coerce(parsed);
}

export interface ReasonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Ask the local model for a mechanism. Throws OllamaUnavailableError only when the
 * server itself cannot be reached - a model that answers badly degrades to prose
 * instead, so the demo never loses the panel entirely.
 */
export async function reasonAboutMutation(
  analysis: AnalysisResult,
  options: ReasonOptions = {},
): Promise<MechanisticReasoning> {
  const features = buildFeatures(analysis);
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: userPrompt(features) },
  ];

  const result = await chat(messages, {
    schema: RESPONSE_SCHEMA,
    temperature: 0.2,
    maxTokens: 700,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });

  const { reasoning, notes } = parseStructuredReasoning(result.content);

  if (reasoning) {
    return {
      mode: "structured",
      model: result.model,
      latencyMs: result.latencyMs,
      loadMs: result.loadMs,
      features,
      reasoning,
      text: null,
      notes,
    };
  }

  // Fallback: same evidence, same rules, no schema. Prose beats an empty panel.
  const prose = await chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `${userPrompt(features)}\n\nAnswer as four short labelled paragraphs: ` +
          "Mechanism, Resistance likelihood, Caveat, What would confirm it.",
      },
    ],
    { temperature: 0.2, maxTokens: 700, signal: options.signal, timeoutMs: options.timeoutMs },
  );

  return {
    mode: "text",
    model: prose.model,
    latencyMs: result.latencyMs + prose.latencyMs,
    loadMs: result.loadMs,
    features,
    reasoning: null,
    text: prose.content.trim(),
    notes: [...notes, "fell back to unstructured output"],
  };
}

export { ollamaModel };
