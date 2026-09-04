/**
 * The structural score - one number, from the measurements, with no model in the loop.
 *
 * Two phases need it and they need the *same* one: Phase 5 ranks a surveillance batch by
 * it, and Phase 6 evaluates it against the golden set. If the eval scored something other
 * than what the triage table sorts by, the eval would be measuring nothing.
 *
 * Deliberately simple, and deliberately not fitted to the golden set: distance to the drug
 * with a modest burial term, exactly the combination Phase 6 set out to test. There is no
 * training here and nothing to overfit - the weights below are a stated prior, so the
 * eval is a genuine test of that prior rather than a report on its own parameters.
 *
 * The catalogue is not an input. That is the whole point: the score has to stand up on a
 * mutation no catalogue has seen, so it may not consult one.
 */

import type { AnalysisResult } from "./analysis";

/** Distance at which the proximity term reaches 1, and where it falls to 0. */
export const PROXIMITY_FULL_ANGSTROMS = 3;
export const PROXIMITY_ZERO_ANGSTROMS = 15;

/** Distance carries the signal; burial only modulates it. */
export const WEIGHT_PROXIMITY = 0.8;
export const WEIGHT_BURIAL = 0.2;

/** At or above this score we call it likely resistant; below NEUTRAL_BELOW, likely neutral. */
export const RESISTANT_AT_OR_ABOVE = 50;
export const NEUTRAL_BELOW = 30;

/** Below this pLDDT the coordinates are not good enough to call anything from. */
export const MIN_USABLE_PLDDT = 70;

export type StructuralCall =
  | "likely resistant"
  | "uncertain"
  | "likely neutral"
  | "insufficient confidence";

export interface StructuralScore {
  /** 0-100. Higher means the geometry looks more like a drug-binding-site disruption. */
  score: number;
  call: StructuralCall;
  components: {
    minDistanceToDrugAngstroms: number;
    proximityTerm: number;
    burialPercentile: number;
    burialTerm: number;
    plddt: number;
  };
  /** One line an analyst can read off the row without opening anything. */
  rationale: string;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** "63rd", not "63th" - the percentile is printed in three places and they should agree. */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function scoreFrom(
  minDistanceToDrugAngstroms: number,
  burialPercentile: number,
  plddt: number,
): StructuralScore {
  const proximityTerm = clamp01(
    (PROXIMITY_ZERO_ANGSTROMS - minDistanceToDrugAngstroms) /
      (PROXIMITY_ZERO_ANGSTROMS - PROXIMITY_FULL_ANGSTROMS),
  );
  const burialTerm = clamp01(burialPercentile / 100);
  const score = Math.round(100 * (WEIGHT_PROXIMITY * proximityTerm + WEIGHT_BURIAL * burialTerm));

  // A low-confidence region is not evidence of anything either way, so it gets its own
  // call rather than being folded into the number and read as "probably harmless".
  const call: StructuralCall =
    plddt < MIN_USABLE_PLDDT
      ? "insufficient confidence"
      : score >= RESISTANT_AT_OR_ABOVE
        ? "likely resistant"
        : score < NEUTRAL_BELOW
          ? "likely neutral"
          : "uncertain";

  const rationale =
    call === "insufficient confidence"
      ? `pLDDT ${plddt} - the local coordinates are too uncertain to measure against.`
      : `${minDistanceToDrugAngstroms} Å from the drug, ${ordinal(burialPercentile)}-percentile burial.`;

  return {
    score,
    call,
    components: {
      minDistanceToDrugAngstroms,
      proximityTerm: +proximityTerm.toFixed(3),
      burialTerm: +burialTerm.toFixed(3),
      burialPercentile,
      plddt,
    },
    rationale,
  };
}

export function scoreAnalysis(analysis: AnalysisResult): StructuralScore {
  return scoreFrom(
    analysis.structure.drug.minDistanceToDrugAngstroms,
    analysis.structure.burial.percentile,
    analysis.structure.confidence.plddt,
  );
}

/** How the score is built, in words, for the UI to print next to the numbers. */
export const SCORE_DEFINITION = [
  `Proximity: 1.0 at ${PROXIMITY_FULL_ANGSTROMS} Å from the drug or closer, falling linearly to 0 at ${PROXIMITY_ZERO_ANGSTROMS} Å.`,
  "Burial: the residue's neighbour-count percentile within this structure, 0-1.",
  `Score = 100 × (${WEIGHT_PROXIMITY} × proximity + ${WEIGHT_BURIAL} × burial).`,
  `≥ ${RESISTANT_AT_OR_ABOVE} likely resistant, < ${NEUTRAL_BELOW} likely neutral, between the two uncertain.`,
  `Below pLDDT ${MIN_USABLE_PLDDT} no call is made at all.`,
  "The catalogue is not an input, so the score is unchanged on a mutation nobody has recorded.",
];
