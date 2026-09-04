/**
 * Phase 5 - surveillance batch triage.
 *
 * A sequenced isolate is not one mutation, it is a list, and the analyst's real question
 * is which one to look at first. This module runs the whole list through the same
 * structural pipeline the single-mutation view uses and ranks the results.
 *
 * The ranking is deterministic and model-free on purpose. It is the structural score from
 * lib/score.ts - the same number Phase 6 evaluates - so the order of this table is a claim
 * the eval actually tests. The local model is asked for a mechanism afterwards, per row,
 * from the browser: it costs ~12 s a mutation, and a table that appears instantly and then
 * fills in beats one that blocks for a minute.
 */

import { AnalysisError, AnalysisResult, analyseMutation } from "./analysis";
import { MutationParseError } from "./mutation";
import { StructuralCall, StructuralScore, scoreAnalysis } from "./score";
import { TargetDefinition, resolveTarget } from "./targets";

/** More than this in one paste is a file upload, not an isolate. */
export const MAX_BATCH = 24;

export interface TriageRow {
  /** Rank in the returned order, 1-based. */
  rank: number;
  input: string;
  canonical: string | null;
  /** Set when this row could not be analysed; every other field is then absent. */
  error: string | null;

  clinicalResnum: number | null;
  uniprotResnum: number | null;
  residueCenter: { x: number; y: number; z: number } | null;

  minDistanceToDrugAngstroms: number | null;
  proximity: string | null;
  plddt: number | null;
  burialPercentile: number | null;
  substitutionSummary: string | null;

  score: StructuralScore | null;

  /** Absent from the bundled catalogue - the case the catalogue cannot help with. */
  novel: boolean;
  catalogueVerdict: string | null;
  catalogueEvidence: string | null;
}

export interface TriageResult {
  target: { id: string; gene: string; organism: string; drug: string };
  /** Same for every row, so the viewer gets it once rather than per row. */
  pocketUniprotResnums: number[];
  requested: number;
  analysed: number;
  failed: number;
  duplicatesDropped: number;
  rows: TriageRow[];
  summary: {
    likelyResistant: number;
    uncertain: number;
    likelyNeutral: number;
    noCall: number;
    /** Rows that score as likely resistant and that the catalogue has never seen. */
    novelHighRisk: string[];
  };
}

/** One per line, or comma/semicolon separated - however an analyst happens to paste it. */
export function parseBatch(input: string): string[] {
  return input
    .split(/[\n;,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Order the buckets are worked through. A residue we cannot measure outranks one we can
 *  measure as harmless: "no call" is a gap in the evidence, not a clean bill of health. */
const CALL_ORDER: Record<StructuralCall, number> = {
  "likely resistant": 0,
  uncertain: 1,
  "insufficient confidence": 2,
  "likely neutral": 3,
};

function rowFrom(input: string, analysis: AnalysisResult): TriageRow {
  const score = scoreAnalysis(analysis);
  const { catalogue, structure } = analysis;

  return {
    rank: 0,
    input,
    canonical: analysis.input.canonical,
    error: null,
    clinicalResnum: analysis.numbering.clinicalResnum,
    uniprotResnum: analysis.numbering.uniprotResnum,
    residueCenter: structure.drug.residueCenter,
    minDistanceToDrugAngstroms: structure.drug.minDistanceToDrugAngstroms,
    proximity: structure.drug.proximity,
    plddt: structure.confidence.plddt,
    burialPercentile: structure.burial.percentile,
    substitutionSummary: analysis.substitution.summary,
    score,
    novel: !catalogue.known,
    catalogueVerdict: catalogue.catalogueOnly.verdict,
    catalogueEvidence: catalogue.exactMatch?.evidence ?? null,
  };
}

function failedRow(input: string, message: string): TriageRow {
  return {
    rank: 0, input, canonical: null, error: message,
    clinicalResnum: null, uniprotResnum: null, residueCenter: null,
    minDistanceToDrugAngstroms: null, proximity: null, plddt: null,
    burialPercentile: null, substitutionSummary: null, score: null,
    novel: false, catalogueVerdict: null, catalogueEvidence: null,
  };
}

/**
 * Rank the isolate. Structural risk first, and within a risk band the mutations the
 * catalogue has never seen first - not because novelty raises the risk, but because those
 * are the rows where nothing else in the analyst's toolkit has anything to say.
 */
function rank(a: TriageRow, b: TriageRow): number {
  if (a.error || b.error) return a.error ? (b.error ? 0 : 1) : -1;
  const call = CALL_ORDER[a.score!.call] - CALL_ORDER[b.score!.call];
  if (call !== 0) return call;
  if (a.novel !== b.novel) return a.novel ? -1 : 1;
  if (b.score!.score !== a.score!.score) return b.score!.score - a.score!.score;
  return a.minDistanceToDrugAngstroms! - b.minDistanceToDrugAngstroms!;
}

export async function triageBatch(
  input: string | string[],
  targetId?: string | null,
): Promise<TriageResult> {
  const target: TargetDefinition | undefined = resolveTarget(targetId, null);
  if (!target) throw new AnalysisError(`Unknown target "${targetId}".`);
  const requestedList = Array.isArray(input) ? input : parseBatch(input);
  if (requestedList.length === 0) {
    throw new MutationParseError("Paste at least one mutation, one per line.");
  }
  if (requestedList.length > MAX_BATCH) {
    throw new AnalysisError(
      `${requestedList.length} mutations is more than this build triages at once (limit ${MAX_BATCH}).`,
    );
  }

  const rows: TriageRow[] = [];
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  let pocketUniprotResnums: number[] = [];

  // Sequential: these are file reads against one cached structure, and the cost is
  // dominated by the first load. Nothing here touches the network or the model.
  for (const one of requestedList) {
    try {
      const analysis = await analyseMutation(one, targetId);
      if (seen.has(analysis.input.canonical)) {
        duplicatesDropped++;
        continue;
      }
      seen.add(analysis.input.canonical);
      pocketUniprotResnums = analysis.pocket.uniprotResnums;
      rows.push(rowFrom(one, analysis));
    } catch (err) {
      if (err instanceof MutationParseError || err instanceof AnalysisError) {
        rows.push(failedRow(one, err.message));
      } else {
        throw err;
      }
    }
  }

  rows.sort(rank);
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });

  const scored = rows.filter((r) => r.score);
  const countOf = (call: StructuralCall) => scored.filter((r) => r.score!.call === call).length;

  return {
    target: { id: target.id, gene: target.gene, organism: target.organism, drug: target.drug },
    pocketUniprotResnums,
    requested: requestedList.length,
    analysed: scored.length,
    failed: rows.length - scored.length,
    duplicatesDropped,
    rows,
    summary: {
      likelyResistant: countOf("likely resistant"),
      uncertain: countOf("uncertain"),
      likelyNeutral: countOf("likely neutral"),
      noCall: countOf("insufficient confidence"),
      novelHighRisk: scored
        .filter((r) => r.novel && r.score!.call === "likely resistant")
        .map((r) => r.canonical!),
    },
  };
}
