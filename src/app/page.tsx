"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import StructureViewer, { ViewerFocus } from "@/components/StructureViewer";
import type { AnalysisResult, CatalogueVerdict } from "@/lib/analysis";
import type { MechanisticReasoning, ResistanceLikelihood } from "@/lib/reasoning";

const HERO_MUTATION = "rpoB S450L";
/**
 * Two of these are the point of the project. S450P sits on the single closest contact
 * residue to rifampicin, and N487D on another contact residue - and CARD catalogues
 * neither. A catalogue-only tool has nothing to say about either one.
 */
const EXAMPLES = [
  "rpoB S450L",
  "rpoB H445Y",
  "rpoB I491F",
  "rpoB S450P",
  "rpoB N487D",
  "rpoB E592D",
];

interface ModelHealth {
  available: boolean;
  model: string;
  modelPresent: boolean;
  host: string;
  message: string | null;
}

export default function Home() {
  const [input, setInput] = useState(HERO_MUTATION);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [reasoning, setReasoning] = useState<MechanisticReasoning | null>(null);
  const [reasoningError, setReasoningError] = useState<string | null>(null);
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const [health, setHealth] = useState<ModelHealth | null>(null);
  const reasoningAbort = useRef<AbortController | null>(null);

  /** Ask the local model for a mechanism, cancelling any question still in flight. */
  const requestReasoning = useCallback(async (mutation: string) => {
    reasoningAbort.current?.abort();
    const controller = new AbortController();
    reasoningAbort.current = controller;

    setReasoning(null);
    setReasoningError(null);
    setReasoningBusy(true);
    try {
      const res = await fetch("/api/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutation }),
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) setReasoningError(body.error ?? "The local model did not answer.");
      else setReasoning(body.reasoning as MechanisticReasoning);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // superseded by a newer question
      setReasoningError("Could not reach the reasoning service.");
    } finally {
      if (reasoningAbort.current === controller) setReasoningBusy(false);
    }
  }, []);

  const analyse = useCallback(
    async (mutation: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mutation }),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Analysis failed.");
          setResult(null);
          reasoningAbort.current?.abort();
          setReasoning(null);
          setReasoningError(null);
          setReasoningBusy(false);
        } else {
          setResult(body as AnalysisResult);
          // The structure renders immediately; the model reasons over it in the background.
          void requestReasoning(mutation);
        }
      } catch {
        setError("Could not reach the analysis service.");
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [requestReasoning],
  );

  // The safety net: the hero case is analysed on load, entirely from local files.
  useEffect(() => {
    void analyse(HERO_MUTATION);
  }, [analyse]);

  // Cold-loading an 8B model costs ~10s, so pay it before anyone is watching.
  useEffect(() => {
    fetch("/api/reason?prewarm=1")
      .then((r) => r.json())
      .then((h: ModelHealth) => setHealth(h))
      .catch(() => setHealth(null));
  }, []);

  const focus: ViewerFocus | null = result
    ? {
        uniprotResnum: result.numbering.uniprotResnum,
        label: `${result.input.canonical} (structure ${result.numbering.uniprotResnum})`,
        pocketUniprotResnums: result.pocket.uniprotResnums,
        center: result.structure.drug.residueCenter,
      }
    : null;

  return (
    <main className="mx-auto grid min-h-screen max-w-[1500px] grid-cols-1 gap-6 p-6 lg:grid-cols-[440px_1fr]">
      <section className="flex flex-col gap-5">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            AMR Resistance Copilot
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
            Structure-grounded interpretation of antimicrobial-resistance mutations. Locates the
            mutation on the drug target and measures its relationship to the drug-binding site —
            including for mutations no catalogue has seen.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void analyse(input);
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="mutation" className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Gene and mutation
          </label>
          <div className="flex gap-2">
            <input
              id="mutation"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="rpoB S450L"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-500"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-teal-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-teal-400 disabled:opacity-50"
            >
              {busy ? "Analysing…" : "Analyse"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setInput(HERO_MUTATION);
                void analyse(HERO_MUTATION);
              }}
              className="rounded-md border border-teal-700 bg-teal-950/60 px-2.5 py-1 text-xs text-teal-300 transition hover:bg-teal-900/60"
            >
              ▶ Demo: {HERO_MUTATION}
            </button>
            {EXAMPLES.slice(1).map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setInput(ex);
                  void analyse(ex);
                }}
                className="rounded-md border border-slate-700 px-2.5 py-1 font-mono text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
              >
                {ex}
              </button>
            ))}
          </div>
        </form>

        {error && (
          <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2.5 text-sm text-red-300">
            {error}
          </p>
        )}

        {result && (
          <ResultPanel
            result={result}
            reasoning={reasoning}
            reasoningBusy={reasoningBusy}
            reasoningError={reasoningError}
            health={health}
          />
        )}
      </section>

      <section className="min-h-[520px] lg:h-[calc(100vh-3rem)] lg:sticky lg:top-6">
        <StructureViewer focus={focus} />
      </section>
    </main>
  );
}

function ResultPanel({
  result,
  reasoning,
  reasoningBusy,
  reasoningError,
  health,
}: {
  result: AnalysisResult;
  reasoning: MechanisticReasoning | null;
  reasoningBusy: boolean;
  reasoningError: string | null;
  health: ModelHealth | null;
}) {
  const { structure, numbering, catalogue, substitution } = result;
  const contact = structure.drug.proximity === "drug-contacting";

  return (
    <div className="flex flex-col gap-4 text-sm">
      <div
        className={`rounded-xl border px-4 py-3 ${
          contact ? "border-amber-700 bg-amber-950/40" : "border-slate-700 bg-slate-900/60"
        }`}
      >
        <p className="text-xs uppercase tracking-wide text-slate-400">Structural call</p>
        <p className="mt-1 leading-relaxed text-slate-100">{result.headline}</p>
      </div>

      {!result.validation.matchesInput && (
        <p className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-300">
          {result.validation.message}
        </p>
      )}

      <CatalogueBanner catalogue={catalogue} residue={numbering.clinicalResnum} />

      <ReasoningPanel
        reasoning={reasoning}
        busy={reasoningBusy}
        error={reasoningError}
        health={health}
        catalogue={catalogue}
        drug={structure.drug}
      />

      <Card title="Measured from coordinates">
        <Metric
          label={`Closest approach to ${result.target.drug}`}
          value={`${structure.drug.minDistanceToDrugAngstroms} Å`}
          note={structure.drug.proximity}
        />
        <Metric
          label="Cα to drug"
          value={`${structure.drug.caDistanceToDrugAngstroms} Å`}
        />
        <Metric
          label="Model confidence (pLDDT)"
          value={`${structure.confidence.plddt}`}
          note={structure.confidence.band}
        />
        <Metric
          label="Burial"
          value={`${structure.burial.neighborCount} neighbours`}
          note={`${structure.burial.band}, ${structure.burial.percentile}th percentile`}
        />
        {structure.drug.nearestPocketResidue && (
          <Metric
            label="Nearest contact residue"
            value={`${structure.drug.nearestPocketResidue.aa}${structure.drug.nearestPocketResidue.clinicalResnum}`}
            note={`${structure.drug.nearestPocketResidue.distanceAngstroms} Å away`}
          />
        )}
      </Card>

      <Card title="Substitution">
        <p className="leading-relaxed text-slate-300">{substitution.summary}</p>
        <p className="mt-1 text-xs text-slate-500">
          {substitution.wildType.name} → {substitution.mutant.name}; hydropathy shift{" "}
          {substitution.hydropathyShift > 0 ? "+" : ""}
          {substitution.hydropathyShift}
        </p>
      </Card>

      <Card title="Numbering">
        <p className="text-xs leading-relaxed text-slate-400">{numbering.explanation}</p>
      </Card>

      <details className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-400">
          Provenance
        </summary>
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-slate-500">
          {result.provenance.map((p) => (
            <li key={p}>· {p}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * The beyond-the-catalogue beat, promoted to sit directly under the structural call.
 * For a novel mutation this is the whole argument in one panel: the catalogue returns
 * nothing, and the tool goes on to make a mechanistic call anyway.
 */
function CatalogueBanner({
  catalogue,
  residue,
}: {
  catalogue: CatalogueVerdict;
  residue: number;
}) {
  const known = catalogue.known;
  const sameResidue = catalogue.sameResidueEntries.map((e) => e.mutation);
  const shown = sameResidue.slice(0, 8);
  const nearby = catalogue.nearbyKnownResistance.slice(0, 4);

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        known ? "border-slate-700 bg-slate-900/60" : "border-fuchsia-800 bg-fuchsia-950/30"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${
            known ? "bg-slate-700 text-slate-200" : "bg-fuchsia-700 text-fuchsia-50"
          }`}
        >
          {known ? `In ${catalogue.name.split(" ")[0]}` : "Not in the catalogue"}
        </span>
        <span className="font-mono text-[11px] text-slate-500">
          {catalogue.entryCount} substitutions · {catalogue.residuesCovered} residues
        </span>
      </div>

      <p className="mt-2 leading-relaxed text-slate-200">{catalogue.catalogueOnly.verdict}</p>

      <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
        {known
          ? "The catalogue already covers this one. The structural call above is an independent read of the same mutation — the same reasoning that has to stand alone when the catalogue is silent."
          : "This is where a catalogue stops, and surveillance keeps producing mutations no catalogue has seen. Everything above and below is measured from the structure, so the call still gets made."}
      </p>

      {!known && sameResidue.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          It does list {sameResidue.length} other substitution
          {sameResidue.length === 1 ? "" : "s"} at residue {residue}:{" "}
          <span className="font-mono text-slate-300">{shown.join(", ")}</span>
          {sameResidue.length > shown.length ? `, and ${sameResidue.length - shown.length} more` : ""}
          {" — but not this one."}
        </p>
      )}

      {!known && nearby.length > 0 && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          Catalogued resistance residues within 8 Å of it:{" "}
          <span className="font-mono text-slate-300">
            {nearby.map((n) => `${n.aa}${n.clinicalResnum} ${n.distanceAngstroms} Å`).join(" · ")}
          </span>
          . Context only — this is catalogue knowledge, and it is kept out of what the model sees.
        </p>
      )}

      {known && catalogue.exactMatch && (
        <p className="mt-2 font-mono text-[11px] text-slate-500">
          {catalogue.aro} · {catalogue.exactMatch.evidence} · {catalogue.exactMatch.variantType}
        </p>
      )}
    </div>
  );
}

const LIKELIHOOD_STYLES: Record<ResistanceLikelihood, string> = {
  high: "border-red-700 bg-red-950/60 text-red-200",
  moderate: "border-amber-700 bg-amber-950/60 text-amber-200",
  low: "border-emerald-800 bg-emerald-950/60 text-emerald-200",
  uncertain: "border-slate-600 bg-slate-800/60 text-slate-300",
};

/**
 * The model never sees the catalogue, so the two can disagree - and when they do it is
 * worth naming rather than quietly resolving. A catalogued mutation far from the drug is
 * the honest failure mode of a structure-only method: distal, allosteric and compensatory
 * resistance looks exactly like this from the binding site.
 */
function disagreementNote(
  catalogue: CatalogueVerdict,
  drug: AnalysisResult["structure"]["drug"],
  likelihood: ResistanceLikelihood,
): string | null {
  if (!catalogue.known) return null;
  if (likelihood !== "low" && likelihood !== "uncertain") return null;
  return (
    `${catalogue.name.split(" ")[0]} lists this substitution as resistance-associated, but it is ` +
    `${drug.minDistanceToDrugAngstroms} Å from the drug, so the structural read is ${likelihood}. ` +
    `Structure only sees the binding site: a distal, allosteric or compensatory mechanism looks ` +
    `exactly like this. Where the catalogue has phenotypic evidence, the catalogue wins.`
  );
}

function ReasoningPanel({
  reasoning,
  busy,
  error,
  health,
  catalogue,
  drug,
}: {
  reasoning: MechanisticReasoning | null;
  busy: boolean;
  error: string | null;
  health: ModelHealth | null;
  catalogue: CatalogueVerdict;
  drug: AnalysisResult["structure"]["drug"];
}) {
  const modelName = reasoning?.model ?? health?.model ?? "qwen3:8b";

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-slate-400">Mechanistic hypothesis</p>
        <p className="font-mono text-[11px] text-slate-500">
          {modelName} · local
          {reasoning ? ` · ${(reasoning.latencyMs / 1000).toFixed(1)}s` : ""}
        </p>
      </div>

      {busy && <Thinking />}

      {!busy && error && (
        <div className="mt-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-300">
          {error}
          <span className="mt-1 block text-amber-400/70">
            The measurements above are computed locally and stand without the model.
          </span>
        </div>
      )}

      {!busy && !error && reasoning?.reasoning && (
        <div className="mt-2.5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
                LIKELIHOOD_STYLES[reasoning.reasoning.resistanceLikelihood]
              }`}
            >
              {reasoning.reasoning.resistanceLikelihood} resistance likelihood
            </span>
          </div>
          <p className="leading-relaxed text-slate-200">{reasoning.reasoning.mechanismHypothesis}</p>
          <Field label="Caveat">{reasoning.reasoning.confidenceCaveat}</Field>
          <Field label="What would confirm it">{reasoning.reasoning.whatWouldConfirm}</Field>
          {(() => {
            const note = disagreementNote(catalogue, drug, reasoning.reasoning.resistanceLikelihood);
            return note ? (
              <p className="rounded-lg border border-amber-800 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-300">
                <span className="font-medium uppercase tracking-wide">Disagreement · </span>
                {note}
              </p>
            ) : null;
          })()}
        </div>
      )}

      {!busy && !error && reasoning?.text && (
        <p className="mt-2.5 whitespace-pre-wrap leading-relaxed text-slate-200">{reasoning.text}</p>
      )}

      {!busy && !error && reasoning && (
        <details className="mt-3 border-t border-slate-800 pt-2">
          <summary className="cursor-pointer text-xs text-slate-500">
            Evidence handed to the model
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            The model sees only these measurements. The catalogue verdict is deliberately withheld,
            so its answer cannot be a memory of a famous mutation.
          </p>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-2.5 font-mono text-[11px] leading-relaxed text-slate-400">
            {JSON.stringify(reasoning.features, null, 2)}
          </pre>
          {reasoning.notes.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-amber-400/80">
              {reasoning.notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}

/** An 8B model on a laptop takes ~10s; show the clock rather than a mute spinner. */
function Thinking() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
      Reasoning over the measurements… {seconds}s
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 leading-relaxed text-slate-300">{children}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-800/70 py-1.5 last:border-0">
      <span className="text-slate-400">{label}</span>
      <span className="text-right">
        <span className="font-mono text-slate-100">{value}</span>
        {note && <span className="ml-2 text-xs text-slate-500">{note}</span>}
      </span>
    </div>
  );
}
