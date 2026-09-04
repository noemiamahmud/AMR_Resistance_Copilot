"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AffinityArm, AffinityComparison, AffinityResult } from "@/lib/affinity";

/**
 * Stretch - the Boltz-2 comparison.
 *
 * The panel is built around one idea: a difference is only worth reporting next to the
 * spread it has to beat. So the individual replicates are plotted as dots on a shared axis
 * rather than collapsed into two means, and if the two clouds overlap you can see that
 * before you read the verdict. Two bars would have hidden exactly the thing that matters.
 */

export default function AffinityPanel({
  mutation,
  targetId,
}: {
  mutation: string;
  targetId: string;
}) {
  const [data, setData] = useState<AffinityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [liveBusy, setLiveBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const receive = useCallback(async (res: Response) => {
    const body = await res.json();
    if (!res.ok) setError(body.error ?? "The affinity comparison failed.");
    else {
      setError(null);
      setData(body as AffinityResult);
    }
  }, []);

  /**
   * Cached only, on mount. A live run is minutes of someone else's rate-limited GPU, so it
   * never happens without a click. Written as an async body rather than a shared helper so
   * that nothing sets state synchronously while the effect is running.
   */
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    (async () => {
      try {
        const res = await fetch(`/api/affinity?mutation=${encodeURIComponent(mutation)}&target=${encodeURIComponent(targetId)}`, {
          signal: controller.signal,
        });
        await receive(res);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError("Could not reach the affinity service.");
      } finally {
        if (abort.current === controller) setBusy(false);
      }
    })();
    return () => controller.abort();
  }, [mutation, targetId, receive]);

  const runLive = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLiveBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/affinity?mutation=${encodeURIComponent(mutation)}&target=${encodeURIComponent(targetId)}&live=1&replicates=3`,
        { signal: controller.signal },
      );
      await receive(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError("Could not reach the affinity service.");
    } finally {
      if (abort.current === controller) setLiveBusy(false);
    }
  }, [mutation, targetId, receive]);

  const comparison = data?.comparison ?? null;

  return (
    <div className="overflow-hidden rounded-xl border border-violet-900/50 bg-violet-950/15">
      <div className="border-l-[3px] border-l-violet-400 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-violet-300">
            Predicted
          </p>
          <p className="font-display mt-1 text-base text-slate-100">
            Predicted rifampicin affinity · wild type vs mutant
          </p>
        </div>
        {comparison && (
          <span className="font-mono text-[11px] text-slate-500">
            Boltz-2 ·{" "}
            <span className={comparison.source === "live" ? "text-violet-300" : "text-slate-500"}>
              {comparison.source}
            </span>
          </span>
        )}
      </div>

      {busy && <p className="mt-3 text-sm text-slate-400">Loading the cached comparison…</p>}

      {error && (
        <p className="mt-3 rounded-lg border border-amber-900/70 bg-amber-950/35 px-3 py-2 text-sm text-amber-200">
          {error}
        </p>
      )}

      {!busy && !error && data?.unavailable && (
        <p className="mt-3 text-sm leading-relaxed text-slate-500">{data.unavailable}</p>
      )}

      {data?.fellBackTo && (
        <p className="mt-3 rounded-lg border border-amber-900/70 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          {data.fellBackTo}
        </p>
      )}

      {comparison && (
        <>
          <Verdict comparison={comparison} />
          <ReplicateStrip comparison={comparison} />
          <Arms comparison={comparison} />

          <details className="mt-4 pt-1">
            <summary className="cursor-pointer text-xs text-slate-500">
              What this prediction is, and what it is not
            </summary>
            <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-500">
              {comparison.caveats.map((c) => (
                <li key={c}>· {c}</li>
              ))}
              <li>
                · Ligand: {comparison.ligand.name} — {comparison.ligand.source}.
              </li>
              <li>
                · {comparison.method.model}, {comparison.method.sequenceLength} residues, MSA:{" "}
                {comparison.method.msa}. {comparison.method.settings}
              </li>
              {comparison.generatedIso && (
                <li>· Run {new Date(comparison.generatedIso).toISOString().slice(0, 10)}.</li>
              )}
            </ul>
          </details>
        </>
      )}

      {data?.liveAvailable && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-violet-900/40 pt-3">
          <button
            type="button"
            onClick={() => void runLive()}
            disabled={liveBusy}
            className="rounded-lg border border-violet-700 bg-violet-950/60 px-3 py-1.5 text-xs text-violet-200 transition hover:bg-violet-900/60 disabled:opacity-50"
          >
            {liveBusy ? "Co-folding…" : "Re-run live (3 replicates each)"}
          </button>
          <span className="text-xs text-slate-500">
            {liveBusy
              ? "Six co-folds of a 1178-residue chain; about four minutes."
              : "Cloud GPU, rate-limited. The cached result above stands if it fails."}
          </span>
        </div>
      )}
      {liveBusy && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-800">
          <div className="h-full w-1/3 animate-progress rounded-full bg-violet-400/90" />
        </div>
      )}
      </div>
    </div>
  );
}

function Verdict({ comparison }: { comparison: AffinityComparison }) {
  const good = comparison.clearsNoise && comparison.direction === "weaker in the mutant";
  return (
    <div
      className={`mt-2.5 rounded-lg border px-3 py-2.5 ${
        good
          ? "border-red-800 bg-red-950/40"
          : comparison.clearsNoise
            ? "border-amber-800 bg-amber-950/30"
            : "border-slate-700 bg-slate-900/60"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono tabular-nums text-xl text-slate-100">
          {comparison.deltaLog10 > 0 ? "+" : ""}
          {comparison.deltaLog10.toFixed(2)}
        </span>
        <span className="text-xs text-slate-400">
          Δ log₁₀ IC₅₀ (mutant − wild type) · ± {comparison.standardError.toFixed(2)} SE ·{" "}
          {comparison.separationSe.toFixed(1)}σ
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{comparison.verdict}</p>

      {/* The reason the panel replicates at all, stated in the numbers from this very run. */}
      <p className="mt-2 border-t border-slate-700/60 pt-2 text-xs leading-relaxed text-slate-400">
        One run of each would have been enough to tell any story you liked: across the{" "}
        <span className="font-mono text-slate-300">{comparison.singlePair.pairs}</span> ways of
        pairing these replicates, the answer ranges from{" "}
        <span className="font-mono text-slate-300">
          {comparison.singlePair.minDeltaLog10.toFixed(2)}
        </span>{" "}
        to{" "}
        <span className="font-mono text-slate-300">
          +{comparison.singlePair.maxDeltaLog10.toFixed(2)}
        </span>{" "}
        — {comparison.singlePair.inResistanceDirection} of them pointing the way resistance
        predicts and{" "}
        {comparison.singlePair.pairs - comparison.singlePair.inResistanceDirection} pointing the
        other way.
      </p>
    </div>
  );
}

/**
 * Every replicate as a dot on one axis. If the clouds overlap, the reader sees the overlap
 * at the same moment they see the means - which is the only honest way to show an effect
 * this close to the noise.
 */
function ReplicateStrip({ comparison }: { comparison: AffinityComparison }) {
  const all = [...comparison.wildType.values, ...comparison.mutant.values];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const pad = Math.max(0.15, (hi - lo) * 0.25);
  const min = lo - pad;
  const max = hi + pad;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  const row = (a: AffinityArm, colour: string, dot: string) => (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-right text-xs text-slate-400">{a.label}</span>
      <span className="relative h-6 flex-1 rounded bg-slate-950/60">
        {a.values.map((v, i) => (
          <span
            key={`${v}-${i}`}
            className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${dot} opacity-70`}
            style={{ left: `${pct(v)}%` }}
            title={`replicate ${i + 1}: ${v.toFixed(3)}`}
          />
        ))}
        <span
          className={`absolute inset-y-0 w-0.5 ${colour}`}
          style={{ left: `${pct(a.affinityMean)}%` }}
          title={`mean ${a.affinityMean.toFixed(3)}`}
        />
      </span>
      <span className="w-24 shrink-0 font-mono tabular-nums text-xs text-slate-300">
        {a.affinityMean.toFixed(2)} ± {a.affinitySd.toFixed(2)}
      </span>
    </div>
  );

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {row(comparison.wildType, "bg-sky-400", "bg-sky-400")}
      {row(comparison.mutant, "bg-fuchsia-400", "bg-fuchsia-400")}
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0" />
        <span className="flex flex-1 justify-between font-mono text-[10px] text-slate-600">
          <span>← tighter binding</span>
          <span>log₁₀ IC₅₀ (µM)</span>
          <span>weaker binding →</span>
        </span>
        <span className="w-24 shrink-0" />
      </div>
    </div>
  );
}

function Arms({ comparison }: { comparison: AffinityComparison }) {
  const cell = (a: AffinityArm) => (
    <div className="flex-1 rounded-lg bg-slate-950/40 px-3 py-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">{a.label}</p>
      <dl className="mt-1 space-y-0.5 text-[11px] text-slate-400">
        <Row k="replicates" v={String(a.n)} />
        <Row k="P(binder)" v={a.bindingProbabilityMean.toFixed(2)} />
        <Row k="complex pLDDT" v={a.complexPlddtMean.toFixed(2)} />
        <Row k="ligand ipTM" v={a.ligandIptmMean.toFixed(2)} />
      </dl>
    </div>
  );
  return <div className="mt-3 flex gap-2">{cell(comparison.wildType)}{cell(comparison.mutant)}</div>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{k}</dt>
      <dd className="font-mono tabular-nums text-slate-300">{v}</dd>
    </div>
  );
}
