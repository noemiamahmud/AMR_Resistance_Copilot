"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CallBadge, LikelihoodBadge, ScoreBar } from "@/components/ScoreUI";
import type { ViewerFocus } from "@/components/StructureViewer";
import { runPool } from "@/lib/pool";
import type { MechanisticReasoning } from "@/lib/reasoning";
import { SCORE_DEFINITION } from "@/lib/score";
import { TARGETS } from "@/lib/targets";
import type { TriageResult, TriageRow } from "@/lib/triage";

/**
 * Phase 5 - the surveillance workflow, which is a list rather than a mutation.
 *
 * The table arrives in one request, ranked, because the ranking is structural and needs no
 * model. The mechanism for each row is then fetched separately, one at a time, so the
 * analyst is reading the ranking while the local model is still working through it.
 */

/**
 * A plausible isolate rather than a curated highlight reel: two catalogued resistance
 * mutations, two the catalogue has never seen sitting on rifampicin-contact residues, the
 * catalogued distal one this method is known to miss, and three ordinary distant changes
 * of the kind that dominate a real variant call.
 */
function isolateFor(targetId: string): string {
  const t = TARGETS.find((x) => x.id === targetId) ?? TARGETS[0];
  const listed = t.examples.map((e) => `${t.gene} ${e.mutation}`);
  // Pad with quiet, distant changes so the table is not all signal - a real variant call is
  // mostly noise, and a triage view that only ever shows hits proves nothing.
  const filler = (t.quietExamples ?? []).map((m) => `${t.gene} ${m}`);
  return [...listed, ...filler].join("\n");
}

/**
 * One at a time, which is measured rather than assumed. Ollama serves a single 8B model
 * serially by default, so a second request in flight buys no throughput: interleaved runs
 * over four mutations came out at 52-56 s either way, while per-row latency roughly doubled
 * (~13 s at one in flight against ~25 s at two). Same total, but a row every ~13 s instead
 * of a pair every ~25 s, which is both sooner and easier to watch. Raise this only against
 * a server configured for parallel requests.
 */
const MODEL_CONCURRENCY = 1;

export default function TriagePanel({
  targetId,
  onSelect,
  onOpenSingle,
  modelAvailable,
}: {
  targetId: string;
  onSelect: (focus: ViewerFocus) => void;
  onOpenSingle: (mutation: string) => void;
  modelAvailable: boolean;
}) {
  const [text, setText] = useState(() => isolateFor(targetId));
  const [result, setResult] = useState<TriageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  /** Mechanism per row, keyed by canonical mutation, as the model gets to each one. */
  const [reasoning, setReasoning] = useState<Record<string, MechanisticReasoning>>({});
  const [reasoningDone, setReasoningDone] = useState(0);
  const [reasoningTotal, setReasoningTotal] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Any in-flight batch belongs to the previous isolate; drop it when this view goes away.
  useEffect(() => () => abort.current?.abort(), []);

  const askModel = useCallback(
    async (rows: TriageRow[], signal: AbortSignal) => {
      const targets = rows.filter((r) => r.canonical && !r.error);
      setReasoningTotal(targets.length);
      setReasoningDone(0);

      await runPool(
        targets,
        MODEL_CONCURRENCY,
        async (row) => {
          try {
            const res = await fetch("/api/reason", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mutation: row.input, target: targetId }),
              signal,
            });
            if (res.ok) {
              const body = await res.json();
              setReasoning((prev) => ({
                ...prev,
                [row.canonical!]: body.reasoning as MechanisticReasoning,
              }));
            }
          } catch {
            /* one row without a mechanism does not invalidate the ranking */
          } finally {
            if (!signal.aborted) setReasoningDone((n) => n + 1);
          }
        },
        signal,
      );
    },
    [targetId],
  );

  const triage = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setBusy(true);
    setError(null);
    setReasoning({});
    setReasoningDone(0);
    setReasoningTotal(0);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutations: text, target: targetId }),
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Triage failed.");
        setResult(null);
        return;
      }
      const triaged = body as TriageResult;
      setResult(triaged);
      if (modelAvailable) void askModel(triaged.rows, controller.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError("Could not reach the triage service.");
    } finally {
      setBusy(false);
    }
  }, [askModel, modelAvailable, text, targetId]);

  const select = (row: TriageRow, pocket: number[]) => {
    if (row.uniprotResnum === null || !row.residueCenter || !result) return;
    const t = TARGETS.find((x) => x.id === result.target.id) ?? TARGETS[0];
    setSelected(row.canonical);
    onSelect({
      uniprotResnum: row.uniprotResnum,
      label: `${row.canonical} (structure ${row.uniprotResnum})`,
      center: row.residueCenter,
      pocketUniprotResnums: pocket,
      structureFile: t.structureFile,
      ligandPoseFile: t.ligandPoseFile,
      ligandCode: t.ligandCode,
      drug: t.drug,
    });
  };

  const lineCount = text.split("\n").filter((l) => l.trim()).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium text-slate-200">Surveillance batch triage</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          A sequenced isolate is a list of mutations, not one. Every row is measured against the
          same structure and ranked by the structural score — and within a risk band, the
          mutations the catalogue has never recorded come first, because those are the ones
          nothing else can help with.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="isolate" className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Isolate mutations — one per line
        </label>
        <textarea
          id="isolate"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          spellCheck={false}
          className="w-full resize-y rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void triage()}
            disabled={busy}
            className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-teal-400 disabled:opacity-50"
          >
            {busy ? "Triaging…" : `Triage ${lineCount} mutation${lineCount === 1 ? "" : "s"}`}
          </button>
          <button
            type="button"
            onClick={() => setText(isolateFor(targetId))}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
          >
            Reset to the demo isolate
          </button>
          {reasoningTotal > 0 && reasoningDone < reasoningTotal && (
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
              mechanisms {reasoningDone}/{reasoningTotal}
            </span>
          )}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}

      {result && (
        <>
          <Summary result={result} />
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-left text-[11px] uppercase tracking-wide text-slate-400">
                  <Th className="w-10">#</Th>
                  <Th>Mutation</Th>
                  <Th className="w-40">Structural score</Th>
                  <Th className="w-36">Call</Th>
                  <Th className="w-24">To drug</Th>
                  <Th className="w-28">Catalogue</Th>
                  <Th className="w-28">Model</Th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <Row
                    key={`${row.input}-${row.rank}`}
                    row={row}
                    selected={selected === row.canonical}
                    reasoning={row.canonical ? reasoning[row.canonical] : undefined}
                    modelPending={
                      modelAvailable &&
                      reasoningTotal > 0 &&
                      !!row.canonical &&
                      !reasoning[row.canonical] &&
                      !row.error
                    }
                    expanded={expanded === row.canonical}
                    onToggle={() => setExpanded(expanded === row.canonical ? null : row.canonical)}
                    onSelect={() => select(row, result.pocketUniprotResnums)}
                    onOpen={() => onOpenSingle(row.input)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <details className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
            <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-400">
              How the ranking is computed
            </summary>
            <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-500">
              {SCORE_DEFINITION.map((line) => (
                <li key={line}>· {line}</li>
              ))}
              <li>
                · Rows are bucketed by call, then novel before catalogued, then by score. Novelty
                never changes the score itself — it only decides which of two equally alarming
                rows an analyst has no other source for.
              </li>
              <li>
                · A residue the model cannot measure confidently ranks above one measured as
                harmless: a gap in the evidence is not a clean result.
              </li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

function Summary({ result }: { result: TriageResult }) {
  const { summary } = result;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-400">
        <span>
          <span className="font-mono text-slate-200">{result.analysed}</span> analysed
        </span>
        <span>
          <span className="font-mono text-red-300">{summary.likelyResistant}</span> likely resistant
        </span>
        <span>
          <span className="font-mono text-amber-300">{summary.uncertain}</span> uncertain
        </span>
        <span>
          <span className="font-mono text-emerald-300">{summary.likelyNeutral}</span> likely neutral
        </span>
        {summary.noCall > 0 && (
          <span>
            <span className="font-mono text-slate-300">{summary.noCall}</span> no call
          </span>
        )}
        {result.failed > 0 && (
          <span className="text-amber-400">
            <span className="font-mono">{result.failed}</span> could not be read
          </span>
        )}
        {result.duplicatesDropped > 0 && (
          <span>
            <span className="font-mono text-slate-300">{result.duplicatesDropped}</span> duplicate
            {result.duplicatesDropped === 1 ? "" : "s"} dropped
          </span>
        )}
      </div>

      {summary.novelHighRisk.length > 0 && (
        <p className="mt-2.5 rounded-lg border border-fuchsia-800 bg-fuchsia-950/30 px-3 py-2 text-xs leading-relaxed text-fuchsia-200">
          <span className="font-medium">
            {summary.novelHighRisk.length} high-risk mutation
            {summary.novelHighRisk.length === 1 ? "" : "s"} the catalogue has never seen:{" "}
            <span className="font-mono">{summary.novelHighRisk.join(", ")}</span>.
          </span>{" "}
          <span className="text-fuchsia-300/80">
            A catalogue-only pipeline returns nothing for {summary.novelHighRisk.length === 1 ? "it" : "these"} and this
            isolate reads as clean.
          </span>
        </p>
      )}
    </div>
  );
}

function Row({
  row,
  selected,
  reasoning,
  modelPending,
  expanded,
  onToggle,
  onSelect,
  onOpen,
}: {
  row: TriageRow;
  selected: boolean;
  reasoning: MechanisticReasoning | undefined;
  modelPending: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpen: () => void;
}) {
  if (row.error) {
    return (
      <tr className="border-b border-slate-800/70 last:border-0">
        <Td className="text-slate-600">{row.rank}</Td>
        <Td className="font-mono text-slate-400">{row.input}</Td>
        <Td colSpan={5} className="text-xs text-amber-400/90">
          {row.error}
        </Td>
      </tr>
    );
  }

  const answer = reasoning?.reasoning ?? null;

  return (
    <>
      <tr
        onClick={onSelect}
        className={`cursor-pointer border-b border-slate-800/70 transition last:border-0 ${
          selected ? "bg-slate-800/60" : "hover:bg-slate-900/60"
        }`}
      >
        <Td className="text-slate-600">{row.rank}</Td>
        <Td>
          <div className="flex items-center gap-2">
            <span className="font-mono text-slate-100">{row.canonical}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:border-teal-600 hover:text-teal-300"
            >
              open
            </button>
          </div>
          <span className="text-[11px] text-slate-500">{row.substitutionSummary}</span>
        </Td>
        <Td>
          <ScoreBar score={row.score!.score} />
        </Td>
        <Td>
          <CallBadge call={row.score!.call} />
        </Td>
        <Td className="font-mono text-xs text-slate-300">
          {row.minDistanceToDrugAngstroms} Å
          <span className="block text-[10px] text-slate-500">{row.proximity}</span>
        </Td>
        <Td>
          {row.novel ? (
            <span className="whitespace-nowrap rounded border border-fuchsia-800 bg-fuchsia-950/40 px-1.5 py-0.5 text-[11px] text-fuchsia-200">
              not listed
            </span>
          ) : (
            <span className="whitespace-nowrap rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[11px] text-slate-300">
              {row.catalogueEvidence ?? "listed"}
            </span>
          )}
        </Td>
        <Td>
          {answer ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="text-left"
              title="Show the mechanism"
            >
              <LikelihoodBadge likelihood={answer.resistanceLikelihood} />
            </button>
          ) : modelPending ? (
            <span className="text-[11px] text-slate-600">waiting…</span>
          ) : (
            <span className="text-[11px] text-slate-700">—</span>
          )}
        </Td>
      </tr>
      {expanded && answer && (
        <tr className="border-b border-slate-800/70 bg-slate-950/50 last:border-0">
          <td />
          <td colSpan={6} className="px-3 py-2.5">
            <p className="text-xs leading-relaxed text-slate-300">{answer.mechanismHypothesis}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
              {answer.confidenceCaveat}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className}`}>{children}</th>;
}

function Td({
  children,
  className = "",
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td colSpan={colSpan} className={`px-3 py-2 align-top ${className}`}>
      {children}
    </td>
  );
}
