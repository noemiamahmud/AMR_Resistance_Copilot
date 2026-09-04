"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CallBadge, LikelihoodBadge, ScoreBar } from "@/components/ScoreUI";
import type { EvalRow, EvaluationResult } from "@/lib/evaluation";
import { runPool } from "@/lib/pool";
import type { MechanisticReasoning, ResistanceLikelihood } from "@/lib/reasoning";

/**
 * Phase 6 - the eval, and the argument it is meant to settle.
 *
 * The deterministic half runs on load and in milliseconds: the structural score against the
 * hand-labelled golden set, then the same catalogued mutations asked again with the
 * catalogue blinded. The model's own verdict is optional and slow, and it is the *pipeline*
 * that gets scored - the agent can call catalogue_lookup, and a method that can read the
 * labels cannot be evaluated against them.
 *
 * The caveats below are rendered as prominently as the numbers on purpose. Ten mutations
 * with proxy negatives is a demonstration; presenting it as a validation would be the one
 * genuinely dishonest thing this project could do.
 */

/**
 * One at a time, which is measured rather than assumed. Ollama serves a single 8B model
 * serially by default, so a second request in flight buys no throughput: interleaved runs
 * over four mutations came out at 52-56 s either way, while per-row latency roughly doubled
 * (~13 s at one in flight against ~25 s at two). Same total, but a row every ~13 s instead
 * of a pair every ~25 s, which is both sooner and easier to watch. Raise this only against
 * a server configured for parallel requests.
 */
const MODEL_CONCURRENCY = 1;

/** The model answers in four bands; two of them mean "the drug is in trouble". */
function likelihoodIsPositive(l: ResistanceLikelihood): boolean {
  return l === "high" || l === "moderate";
}

export default function EvalPanel() {
  const [data, setData] = useState<EvaluationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [verdicts, setVerdicts] = useState<Record<string, MechanisticReasoning>>({});
  const [modelBusy, setModelBusy] = useState(false);
  const [modelDone, setModelDone] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/eval")
      .then(async (r) => {
        const body = await r.json();
        if (cancelled) return;
        if (!r.ok) setError(body.error ?? "The evaluation could not be run.");
        else setData(body as EvaluationResult);
      })
      .catch(() => {
        if (!cancelled) setError("Could not reach the evaluation service.");
      });
    return () => {
      cancelled = true;
      abort.current?.abort();
    };
  }, []);

  const runModel = useCallback(async () => {
    if (!data) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setModelBusy(true);
    setVerdicts({});
    setModelDone(0);
    await runPool(
      data.separation.rows,
      MODEL_CONCURRENCY,
      async (row) => {
        try {
          const res = await fetch("/api/reason", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mutation: row.mutation }),
            signal: controller.signal,
          });
          if (res.ok) {
            const body = await res.json();
            setVerdicts((prev) => ({ ...prev, [row.mutation]: body.reasoning }));
          }
        } catch {
          /* a missing verdict is reported as a gap, not as a failure of the run */
        } finally {
          if (!controller.signal.aborted) setModelDone((n) => n + 1);
        }
      },
      controller.signal,
    );
    if (!controller.signal.aborted) setModelBusy(false);
  }, [data]);

  if (error) {
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2.5 text-sm text-red-300">
        {error}
      </p>
    );
  }
  if (!data) {
    return <p className="text-sm text-slate-400">Running the evaluation…</p>;
  }

  const { separation, generalization, knownFailure } = data;

  const scored = data.separation.rows.filter((r) => verdicts[r.mutation]?.reasoning);
  const modelCorrect = scored.filter((r) => {
    const l = verdicts[r.mutation].reasoning!.resistanceLikelihood;
    return r.label === "resistant" ? likelihoodIsPositive(l) : !likelihoodIsPositive(l);
  }).length;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-sm font-medium text-slate-200">Separation and generalization eval</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">
          {data.purpose} Two questions, asked separately: does the structural score split the
          hand-labelled classes, and does it still make the call when the catalogue is taken away?
        </p>
      </div>

      {/* ---- Eval 1: separation ---------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionTitle
          n={1}
          title="Separation"
          subtitle={`${separation.resistantCount} catalogued resistant against ${separation.neutralCount} proxy-neutral, scored from coordinates alone.`}
        />

        <div className="flex flex-wrap gap-2">
          <Stat label="Accuracy" value={`${Math.round(separation.accuracy * 100)}%`} />
          <Stat label="Sensitivity" value={`${Math.round(separation.sensitivity * 100)}%`} />
          <Stat label="Specificity" value={`${Math.round(separation.specificity * 100)}%`} />
          <Stat label="AUROC" value={separation.auroc.toFixed(2)} />
          <Stat
            label="Margin"
            value={`${separation.margin.gap} pts`}
            note={`${separation.margin.lowestResistant} vs ${separation.margin.highestNeutral}`}
          />
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2 font-medium">Mutation</th>
                <th className="px-3 py-2 font-medium">Label</th>
                <th className="w-44 px-3 py-2 font-medium">Score</th>
                <th className="w-36 px-3 py-2 font-medium">Structural call</th>
                <th className="w-28 px-3 py-2 font-medium">To drug</th>
                <th className="w-20 px-3 py-2 font-medium">pLDDT</th>
                <th className="w-16 px-3 py-2 font-medium">Hit</th>
                {(modelBusy || scored.length > 0) && (
                  <th className="w-28 px-3 py-2 font-medium">Model</th>
                )}
              </tr>
            </thead>
            <tbody>
              {separation.rows.map((row) => (
                <SeparationRow
                  key={row.mutation}
                  row={row}
                  showModel={modelBusy || scored.length > 0}
                  reasoning={verdicts[row.mutation]}
                  pending={modelBusy && !verdicts[row.mutation]}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runModel()}
            disabled={modelBusy}
            className="rounded-lg border border-teal-700 bg-teal-950/60 px-3 py-1.5 text-xs text-teal-300 transition hover:bg-teal-900/60 disabled:opacity-50"
          >
            {modelBusy ? "Asking the model…" : "Also score the model on this set"}
          </button>
          {modelBusy && (
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
              {modelDone}/{separation.rows.length} · <Elapsed />
            </span>
          )}
          {!modelBusy && scored.length > 0 && (
            <span className="text-xs text-slate-400">
              Model agreed with the label on{" "}
              <span className="font-mono text-slate-200">
                {modelCorrect}/{scored.length}
              </span>{" "}
              — counting <span className="font-mono">high</span> and{" "}
              <span className="font-mono">moderate</span> as a resistance call.
            </span>
          )}
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          The model scored here is the <span className="text-slate-300">pipeline</span>, which is
          never shown the catalogue. The agent is deliberately not scored: it can call{" "}
          <span className="font-mono">catalogue_lookup</span>, so on a catalogued mutation it can
          read the label, and a method that can read the labels cannot be evaluated against them.
        </p>

        <Caveat title="What these labels are">
          <p>
            <span className="font-medium text-slate-300">Resistant:</span>{" "}
            {data.labelSources.resistant}
          </p>
          <p className="mt-1.5">
            <span className="font-medium text-slate-300">Neutral:</span> {data.labelSources.neutral}
          </p>
        </Caveat>

        {separation.provenanceChecksPassed && (
          <p className="text-[11px] text-slate-500">
            Every distance in the table was recomputed from coordinates for this run and matched
            the value recorded in the golden set, so the labels and the measurements are not
            reading each other.
          </p>
        )}
      </section>

      {/* ---- Eval 2: generalization ------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <SectionTitle
          n={2}
          title="Generalization past the catalogue"
          subtitle={generalization.description}
        />

        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[700px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2 font-medium">Mutation</th>
                <th className="px-3 py-2 font-medium">Catalogue lookup, blinded</th>
                <th className="w-44 px-3 py-2 font-medium">Structural call</th>
                <th className="w-24 px-3 py-2 font-medium">Caught</th>
              </tr>
            </thead>
            <tbody>
              {generalization.rows.map((row) => (
                <tr key={row.mutation} className="border-b border-slate-800/70 last:border-0">
                  <td className="px-3 py-2 align-top font-mono text-slate-100">{row.mutation}</td>
                  <td className="px-3 py-2 align-top">
                    <span className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[11px] text-slate-300">
                      no call
                    </span>
                    <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
                      {row.catalogueBlinded.verdict}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <CallBadge call={row.structural.call} />
                    <span className="mt-1 block font-mono text-[11px] text-slate-500">
                      score {row.structural.score} · {row.structural.rationale}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {row.stillFlagged ? (
                      <span className="text-teal-300">✓</span>
                    ) : (
                      <span className="text-amber-400">✗</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Caveat title="Read this one carefully">
          <p>{generalization.note}</p>
          {generalization.rows[0] && (
            <p className="mt-1.5">
              The score&apos;s only inputs are{" "}
              <span className="font-mono text-slate-400">
                {generalization.rows[0].scoreInputs.join(" · ")}
              </span>
              . There is no catalogue parameter to blind, which is the property being demonstrated
              rather than a claim being made about it.
            </p>
          )}
        </Caveat>
      </section>

      {/* ---- The declared failure -------------------------------------------------- */}
      {knownFailure && knownFailure.rows.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionTitle n={3} title="Declared failure case" subtitle={knownFailure.description} />
          {knownFailure.rows.map((row) => (
            <div
              key={row.mutation}
              className="rounded-xl border border-amber-800 bg-amber-950/25 px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-slate-100">{row.mutation}</span>
                <span className="rounded border border-slate-700 bg-slate-800/60 px-1.5 py-0.5 text-[11px] text-slate-300">
                  labelled {row.label}
                </span>
                <CallBadge call={row.score.call} />
                <span className="font-mono text-[11px] text-slate-400">
                  score {row.score.score} · {row.score.components.minDistanceToDrugAngstroms} Å
                </span>
                <span
                  className={`text-[11px] ${row.asExpected ? "text-amber-300" : "text-red-300"}`}
                >
                  {row.asExpected ? "fails as predicted" : "did not fail as predicted"}
                </span>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-amber-200/90">{row.why}</p>
              <p className="mt-1 text-[11px] text-slate-500">{row.labelSource}</p>
            </div>
          ))}
        </section>
      )}

      {/* ---- The honest reading ---------------------------------------------------- */}
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
        <p className="text-xs uppercase tracking-wide text-slate-400">How to read this</p>
        <ul className="mt-2 space-y-2 text-xs leading-relaxed text-slate-400">
          {data.interpretation.map((line) => (
            <li key={line}>· {line}</li>
          ))}
        </ul>
      </section>

      <details className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-400">
          The score being evaluated
        </summary>
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-500">
          {data.scoreDefinition.map((line) => (
            <li key={line}>· {line}</li>
          ))}
          <li>
            · Fixed before the set was scored and unchanged since. Nothing here is fitted, so there
            is nothing to overfit — but equally, nothing about these ten mutations has been used to
            make the score better.
          </li>
        </ul>
      </details>
    </div>
  );
}

function SeparationRow({
  row,
  showModel,
  reasoning,
  pending,
}: {
  row: EvalRow;
  showModel: boolean;
  reasoning: MechanisticReasoning | undefined;
  pending: boolean;
}) {
  const answer = reasoning?.reasoning ?? null;
  return (
    <tr className="border-b border-slate-800/70 last:border-0">
      <td className="px-3 py-2 align-middle font-mono text-slate-100">{row.mutation}</td>
      <td className="px-3 py-2 align-middle">
        <span
          className={`rounded border px-1.5 py-0.5 text-[11px] ${
            row.label === "resistant"
              ? "border-red-800 bg-red-950/40 text-red-200"
              : "border-emerald-900 bg-emerald-950/40 text-emerald-200"
          }`}
        >
          {row.label}
        </span>
        {row.evidence && (
          <span className="ml-1.5 font-mono text-[10px] text-slate-500">{row.evidence}</span>
        )}
      </td>
      <td className="px-3 py-2 align-middle">
        <ScoreBar score={row.score.score} />
      </td>
      <td className="px-3 py-2 align-middle">
        <CallBadge call={row.score.call} />
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-slate-300">
        {row.measuredDistanceAngstroms} Å
      </td>
      <td className="px-3 py-2 align-middle font-mono text-xs text-slate-400">{row.plddt}</td>
      <td className="px-3 py-2 align-middle">
        {row.correct ? (
          <span className="text-teal-300">✓</span>
        ) : (
          <span className="text-amber-400">✗</span>
        )}
      </td>
      {showModel && (
        <td className="px-3 py-2 align-middle">
          {answer ? (
            <LikelihoodBadge likelihood={answer.resistanceLikelihood} />
          ) : pending ? (
            <span className="text-[11px] text-slate-600">waiting…</span>
          ) : (
            <span className="text-[11px] text-slate-700">—</span>
          )}
        </td>
      )}
    </tr>
  );
}

/** Local-model latency is a property of the machine, so count up rather than predict. */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="font-mono">{seconds}s</span>;
}

function SectionTitle({ n, title, subtitle }: { n: number; title: string; subtitle: string }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-slate-700 text-[11px] text-slate-400">
        {n}
      </span>
      <div>
        <p className="text-sm font-medium text-slate-200">{title}</p>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-500">{subtitle}</p>
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-mono text-base text-slate-100">{value}</p>
      {note && <p className="font-mono text-[10px] text-slate-500">{note}</p>}
    </div>
  );
}

function Caveat({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{title}</p>
      <div className="mt-1.5 text-[11px] leading-relaxed text-slate-500">{children}</div>
    </div>
  );
}
