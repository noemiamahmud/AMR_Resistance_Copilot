/**
 * Phase 6 - separation and generalization.
 *
 * Two questions, and they are different questions.
 *
 *  1. SEPARATION. Does the structural score in lib/score.ts actually split the hand-labelled
 *     resistant mutations from the neutral ones? This is the score's own claim, tested.
 *  2. GENERALIZATION. Take a catalogued resistance mutation, blind the catalogue to it, and
 *     ask both methods. The lookup returns nothing; the structure returns the same call it
 *     returned before. That is the project's thesis reduced to a single row.
 *
 * The score is not fitted to this set - it is the stated prior in lib/score.ts, unchanged -
 * so what follows is a test rather than a self-report.
 *
 * Everything is recomputed from coordinates here. The golden-set file carries a distance
 * per entry, but it is used only as a cross-check against the value this build measures;
 * the eval never reads a number it did not compute.
 *
 * Which path is scored matters. The pipeline is evaluated, not the agent: the agent may
 * call catalogue_lookup, so on a catalogued mutation it is not blind to the answer, and an
 * eval of a method that can see the labels measures nothing. The pipeline never sees the
 * catalogue (lib/reasoning.ts), which is exactly what makes it scorable here.
 */

import { promises as fs } from "fs";
import path from "path";

import { analyseMutation, loadAssets } from "./analysis";
import { SCORE_DEFINITION, StructuralScore, ordinal, scoreAnalysis } from "./score";
import { RPOB_RIFAMPICIN, TARGETS, TargetDefinition } from "./targets";

export type Label = "resistant" | "neutral";

interface GoldenEntry {
  mutation: string;
  distanceToDrugAngstroms?: number;
  evidence?: string;
  citation?: string;
  substitutionClass?: string;
}

interface GoldenFailureEntry {
  mutation: string;
  label: Label;
  labelSource: string;
  expectedStructuralCall: string;
  why: string;
}

interface GoldenSetFile {
  purpose: string;
  target: string;
  organism: string;
  drug: string;
  numbering: string;
  resistant: { labelSource: string; entries: GoldenEntry[] };
  neutral: { labelSource: string; entries: GoldenEntry[] };
  generalizationProbe: { description: string; suggestedMutation: string; rationale: string };
  knownFailure?: { description: string; entries: GoldenFailureEntry[] };
}

export interface EvalRow {
  mutation: string;
  label: Label;
  score: StructuralScore;
  /** Did the score's call match the hand label? "uncertain" counts as neither. */
  correct: boolean;
  predicted: string;
  plddt: number;
  /** The golden file's recorded distance against the one this build measures. */
  storedDistanceAngstroms: number | null;
  measuredDistanceAngstroms: number;
  distanceAgrees: boolean;
  evidence: string | null;
  citation: string | null;
  substitutionClass: string | null;
}

export interface SeparationResult {
  rows: EvalRow[];
  resistantCount: number;
  neutralCount: number;
  threshold: number;
  accuracy: number;
  sensitivity: number;
  specificity: number;
  /** Rank-based AUROC (Mann-Whitney U). 1.0 is a perfect ordering. */
  auroc: number;
  /** The gap between the worst resistant score and the best neutral one. */
  margin: { lowestResistant: number; highestNeutral: number; gap: number };
  fullySeparated: boolean;
  /** Every stored distance in the golden file matched what this build measured. */
  provenanceChecksPassed: boolean;
}

export interface GeneralizationRow {
  mutation: string;
  /** What the catalogue says today. */
  catalogueActual: { known: boolean; verdict: string; evidence: string | null };
  /** What it says once this entry is hidden - i.e. if the mutation had never been seen. */
  catalogueBlinded: { known: boolean; verdict: string };
  /** The structural call, computed with the catalogue blinded. */
  structural: StructuralScore;
  /** Was the same call still made without the catalogue? */
  stillFlagged: boolean;
  /** What the score is computed from - the catalogue is verifiably not on this list. */
  scoreInputs: string[];
}

export interface GeneralizationResult {
  description: string;
  rows: GeneralizationRow[];
  caughtWithoutCatalogue: number;
  total: number;
  note: string;
}

export interface KnownFailureRow {
  mutation: string;
  label: Label;
  labelSource: string;
  expectedStructuralCall: string;
  actualStructuralCall: string;
  asExpected: boolean;
  score: StructuralScore;
  why: string;
}

export interface EvaluationResult {
  target: { gene: string; organism: string; drug: string };
  purpose: string;
  scoreDefinition: string[];
  labelSources: { resistant: string; neutral: string };
  separation: SeparationResult;
  generalization: GeneralizationResult;
  knownFailure: { description: string; rows: KnownFailureRow[] } | null;
  /** The honest reading of the numbers above, written before anyone asks for it. */
  interpretation: string[];
}

async function readGoldenSet(target: TargetDefinition): Promise<GoldenSetFile | null> {
  if (!target.goldenSetFile) return null;
  const raw = await fs.readFile(path.join(process.cwd(), "public", target.goldenSetFile), "utf8");
  return JSON.parse(raw) as GoldenSetFile;
}

/** Distances agree to within rounding of the two independent computations. */
const DISTANCE_TOLERANCE_ANGSTROMS = 0.05;

async function evaluateEntry(entry: GoldenEntry, label: Label, targetId: string): Promise<EvalRow> {
  const analysis = await analyseMutation(entry.mutation, targetId);
  const score = scoreAnalysis(analysis);
  const measured = analysis.structure.drug.minDistanceToDrugAngstroms;
  const stored = entry.distanceToDrugAngstroms ?? null;

  return {
    mutation: analysis.input.canonical,
    label,
    score,
    predicted: score.call,
    correct:
      label === "resistant" ? score.call === "likely resistant" : score.call === "likely neutral",
    plddt: analysis.structure.confidence.plddt,
    storedDistanceAngstroms: stored,
    measuredDistanceAngstroms: measured,
    distanceAgrees: stored === null || Math.abs(stored - measured) <= DISTANCE_TOLERANCE_ANGSTROMS,
    evidence: entry.evidence ?? null,
    citation: entry.citation ?? null,
    substitutionClass: entry.substitutionClass ?? null,
  };
}

/**
 * AUROC as the probability that a randomly chosen resistant mutation outranks a randomly
 * chosen neutral one, ties counting a half. With ten entries this is worth reporting only
 * alongside the raw scores, which is why the rows are returned too.
 */
function auroc(resistant: number[], neutral: number[]): number {
  if (resistant.length === 0 || neutral.length === 0) return NaN;
  let wins = 0;
  for (const r of resistant) {
    for (const n of neutral) {
      if (r > n) wins += 1;
      else if (r === n) wins += 0.5;
    }
  }
  return +(wins / (resistant.length * neutral.length)).toFixed(3);
}

/** Which targets can be evaluated at all - i.e. which have hand-labelled ground truth. */
export function targetsWithGoldenSet(): { id: string; gene: string; drug: string }[] {
  return TARGETS.filter((t) => t.goldenSetFile).map((t) => ({ id: t.id, gene: t.gene, drug: t.drug }));
}

export async function runEvaluation(
  target: TargetDefinition = RPOB_RIFAMPICIN,
): Promise<EvaluationResult | { noGoldenSet: true; target: { gene: string; drug: string }; available: { id: string; gene: string; drug: string }[] }> {
  const golden = await readGoldenSet(target);
  if (!golden) {
    return {
      noGoldenSet: true,
      target: { gene: target.gene, drug: target.drug },
      available: targetsWithGoldenSet(),
    };
  }
  const assets = await loadAssets(target);

  const rows: EvalRow[] = [
    ...(await Promise.all(golden.resistant.entries.map((e) => evaluateEntry(e, "resistant", target.id)))),
    ...(await Promise.all(golden.neutral.entries.map((e) => evaluateEntry(e, "neutral", target.id)))),
  ].sort((a, b) => b.score.score - a.score.score);

  const resistantScores = rows.filter((r) => r.label === "resistant").map((r) => r.score.score);
  const neutralScores = rows.filter((r) => r.label === "neutral").map((r) => r.score.score);
  const lowestResistant = Math.min(...resistantScores);
  const highestNeutral = Math.max(...neutralScores);

  const correct = rows.filter((r) => r.correct).length;
  const separation: SeparationResult = {
    rows,
    resistantCount: resistantScores.length,
    neutralCount: neutralScores.length,
    threshold: 50,
    accuracy: +(correct / rows.length).toFixed(3),
    sensitivity: +(
      rows.filter((r) => r.label === "resistant" && r.correct).length / resistantScores.length
    ).toFixed(3),
    specificity: +(
      rows.filter((r) => r.label === "neutral" && r.correct).length / neutralScores.length
    ).toFixed(3),
    auroc: auroc(resistantScores, neutralScores),
    margin: {
      lowestResistant,
      highestNeutral,
      gap: lowestResistant - highestNeutral,
    },
    fullySeparated: lowestResistant > highestNeutral,
    provenanceChecksPassed: rows.every((r) => r.distanceAgrees),
  };

  // Generalization: every catalogued entry in the resistant set, asked as though it had
  // never been recorded. Blinding is a real edit to the lookup, not a description of one.
  const generalizationRows: GeneralizationRow[] = await Promise.all(
    golden.resistant.entries.map(async (entry) => {
      const analysis = await analyseMutation(entry.mutation, target.id);
      const canonical = analysis.input.canonical;
      const actual = assets.catalogue.entries.find((e) => e.mutation === canonical) ?? null;
      const blindedEntries = assets.catalogue.entries.filter((e) => e.mutation !== canonical);
      const blindedHit = blindedEntries.find((e) => e.mutation === canonical) ?? null;
      const score = scoreAnalysis(analysis);

      return {
        mutation: canonical,
        catalogueActual: {
          known: actual !== null,
          verdict: actual
            ? `${assets.catalogue.catalogue} lists ${canonical} as a ${actual.variantType}.`
            : `${assets.catalogue.catalogue} has no entry for ${canonical}.`,
          evidence: actual?.evidence ?? null,
        },
        catalogueBlinded: {
          known: blindedHit !== null,
          verdict: `${assets.catalogue.catalogue} has no entry for ${canonical}. A catalogue lookup ends here.`,
        },
        structural: score,
        stillFlagged: score.call === "likely resistant",
        // Blinding cannot move this number, and that is a property of the code rather than
        // a claim about it: scoreFrom() takes these three measurements and has no catalogue
        // parameter to pass one through.
        scoreInputs: [
          `distance to drug ${score.components.minDistanceToDrugAngstroms} Å`,
          `burial ${ordinal(score.components.burialPercentile)} percentile`,
          `pLDDT ${score.components.plddt}`,
        ],
      };
    }),
  );

  const caught = generalizationRows.filter((r) => r.stillFlagged).length;

  const failureRows: KnownFailureRow[] = golden.knownFailure
    ? await Promise.all(
        golden.knownFailure.entries.map(async (entry) => {
          const score = scoreAnalysis(await analyseMutation(entry.mutation, target.id));
          return {
            mutation: entry.mutation,
            label: entry.label,
            labelSource: entry.labelSource,
            expectedStructuralCall: entry.expectedStructuralCall,
            actualStructuralCall: score.call,
            asExpected: score.call === entry.expectedStructuralCall,
            score,
            why: entry.why,
          };
        }),
      )
    : [];

  return {
    target: { gene: target.gene, organism: target.organism, drug: target.drug },
    purpose: golden.purpose,
    scoreDefinition: SCORE_DEFINITION,
    labelSources: {
      resistant: golden.resistant.labelSource,
      neutral: golden.neutral.labelSource,
    },
    separation,
    generalization: {
      description: golden.generalizationProbe.description,
      rows: generalizationRows,
      caughtWithoutCatalogue: caught,
      total: generalizationRows.length,
      note:
        `${caught} of ${generalizationRows.length} were still called likely resistant with the ` +
        "catalogue blinded. That result is not a surprise and is not meant to be: the score " +
        "never reads the catalogue, so blinding it cannot change the number. What the probe " +
        "demonstrates is the other half - that the lookup, the tool a lab would actually reach " +
        "for, returns nothing at all in exactly the situation surveillance keeps producing.",
    },
    knownFailure: golden.knownFailure
      ? { description: golden.knownFailure.description, rows: failureRows }
      : null,
    interpretation: [
      separation.fullySeparated
        ? `The two classes are fully separated: the lowest resistant score is ${separation.margin.lowestResistant} and the highest neutral score is ${separation.margin.highestNeutral}, a gap of ${separation.margin.gap} points with the threshold at ${separation.threshold}.`
        : `The classes overlap: the lowest resistant score is ${separation.margin.lowestResistant} against a highest neutral of ${separation.margin.highestNeutral}.`,
      "That separation is real but it is not hard-won. The negatives are proxy negatives, chosen to be structurally distant, and at 30-46 Å from the drug the distance term alone puts them at zero. This set shows the score measures what it says it measures; it does not show the score is difficult to satisfy.",
      "Ten mutations is a demonstration, not a validation. The confidence interval on an accuracy computed from five positives and five negatives is wide enough to swallow most of the result.",
      failureRows.length > 0
        ? `The declared failure case is the honest counterweight: ${failureRows.map((f) => f.mutation).join(", ")} is catalogued as resistance-associated and the structural score calls it ${failureRows[0]?.actualStructuralCall}. A binding-site measurement cannot see a distal or compensatory mechanism, and no amount of separation on the set above changes that.`
        : "",
      "The path scored here is the pipeline, which is never shown the catalogue. The agent is not scored, because it may call catalogue_lookup and would therefore be reading the labels.",
    ].filter(Boolean),
  };
}
