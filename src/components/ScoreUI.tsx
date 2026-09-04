"use client";

import type { ResistanceLikelihood } from "@/lib/reasoning";
import { NEUTRAL_BELOW, RESISTANT_AT_OR_ABOVE, StructuralCall } from "@/lib/score";

/** Shared between the triage table and the eval, which have to agree on what a call looks like. */
export const CALL_STYLES: Record<StructuralCall, string> = {
  "likely resistant": "border-red-700 bg-red-950/60 text-red-200",
  uncertain: "border-amber-700 bg-amber-950/60 text-amber-200",
  "likely neutral": "border-emerald-800 bg-emerald-950/60 text-emerald-200",
  "insufficient confidence": "border-slate-600 bg-slate-800/60 text-slate-300",
};

export const LIKELIHOOD_STYLES: Record<ResistanceLikelihood, string> = {
  high: "border-red-700 bg-red-950/60 text-red-200",
  moderate: "border-amber-700 bg-amber-950/60 text-amber-200",
  low: "border-emerald-800 bg-emerald-950/60 text-emerald-200",
  uncertain: "border-slate-600 bg-slate-800/60 text-slate-300",
};

export function CallBadge({ call }: { call: StructuralCall }) {
  return (
    <span
      className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium tracking-wide ${CALL_STYLES[call]}`}
    >
      {call}
    </span>
  );
}

export function LikelihoodBadge({ likelihood }: { likelihood: ResistanceLikelihood }) {
  return (
    <span
      className={`whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium tracking-wide ${LIKELIHOOD_STYLES[likelihood]}`}
    >
      {likelihood}
    </span>
  );
}

/**
 * The score with both thresholds drawn on it. A bare number says nothing about how close
 * to the line it fell, and how close to the line it fell is the whole question.
 */
export function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-right font-mono tabular-nums text-xs text-slate-200">{score}</span>
      <span className="relative h-2 min-w-[52px] flex-1 overflow-hidden rounded-full bg-slate-800">
        <span
          className={`absolute inset-y-0 left-0 rounded-full ${
            score >= RESISTANT_AT_OR_ABOVE
              ? "bg-red-500"
              : score < NEUTRAL_BELOW
                ? "bg-emerald-500"
                : "bg-amber-500"
          }`}
          style={{ width: `${Math.max(2, score)}%` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-slate-500"
          style={{ left: `${NEUTRAL_BELOW}%` }}
          title={`likely neutral below ${NEUTRAL_BELOW}`}
        />
        <span
          className="absolute inset-y-0 w-px bg-slate-400"
          style={{ left: `${RESISTANT_AT_OR_ABOVE}%` }}
          title={`likely resistant at or above ${RESISTANT_AT_OR_ABOVE}`}
        />
      </span>
    </div>
  );
}
