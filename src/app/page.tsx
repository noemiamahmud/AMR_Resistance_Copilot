"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import AffinityPanel from "@/components/AffinityPanel";
import EvalPanel from "@/components/EvalPanel";
import StructureViewer, { ViewerFocus } from "@/components/StructureViewer";
import TriagePanel from "@/components/TriagePanel";
import type { AgentRun, ToolCallRecord } from "@/lib/agent";
import type { AnalysisResult, CatalogueVerdict } from "@/lib/analysis";
import type { MechanisticReasoning, ResistanceLikelihood } from "@/lib/reasoning";
import { ordinal } from "@/lib/score";

/**
 * Two ways of asking the same question. The pipeline hands the model a finished feature
 * payload; the agent hands it a mutation string and makes it measure the structure itself,
 * one tool call at a time, and shows the trace. The pipeline is the fast, deterministic
 * path and stays the default - the agent costs five or six model round trips.
 */
type Mode = "pipeline" | "agent";

/**
 * Three views over the same bundled structure and the same measurements. One mutation is
 * the explanation; an isolate is the workflow an analyst actually has; the eval is the
 * evidence that the ranking in the middle view means anything.
 */
type View = "single" | "triage" | "eval";

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

  const [view, setView] = useState<View>("single");
  const [triageFocus, setTriageFocus] = useState<ViewerFocus | null>(null);

  const [mode, setMode] = useState<Mode>("pipeline");
  const [reasoning, setReasoning] = useState<MechanisticReasoning | null>(null);
  const [agent, setAgent] = useState<AgentRun | null>(null);
  const [reasoningError, setReasoningError] = useState<string | null>(null);
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState(HERO_MUTATION);
  const [health, setHealth] = useState<ModelHealth | null>(null);
  const reasoningAbort = useRef<AbortController | null>(null);

  /** Ask the local model for a mechanism, cancelling any question still in flight. */
  const requestReasoning = useCallback(async (mutation: string, nextMode: Mode) => {
    reasoningAbort.current?.abort();
    const controller = new AbortController();
    reasoningAbort.current = controller;

    setReasoning(null);
    setAgent(null);
    setReasoningError(null);
    setReasoningBusy(true);
    try {
      const res = await fetch(nextMode === "agent" ? "/api/agent" : "/api/reason", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutation }),
        signal: controller.signal,
      });
      const body = await res.json();
      if (!res.ok) setReasoningError(body.error ?? "The local model did not answer.");
      else if (nextMode === "agent") setAgent(body as AgentRun);
      else setReasoning(body.reasoning as MechanisticReasoning);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // superseded by a newer question
      setReasoningError("Could not reach the reasoning service.");
    } finally {
      if (reasoningAbort.current === controller) setReasoningBusy(false);
    }
  }, []);

  const analyse = useCallback(
    async (mutation: string, nextMode: Mode = mode) => {
      setBusy(true);
      setError(null);
      setLastQuery(mutation);
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
          setAgent(null);
          setReasoningError(null);
          setReasoningBusy(false);
        } else {
          setResult(body as AnalysisResult);
          // The structure renders immediately; the model reasons over it in the background.
          void requestReasoning(mutation, nextMode);
        }
      } catch {
        setError("Could not reach the analysis service.");
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [mode, requestReasoning],
  );

  // The safety net: the hero case is analysed on load, entirely from local files.
  useEffect(() => {
    void analyse(HERO_MUTATION, "pipeline");
    // Load-time only; switching mode later re-runs through switchMode, not through here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cold-loading an 8B model costs ~10s, so pay it before anyone is watching.
  useEffect(() => {
    fetch("/api/reason?prewarm=1")
      .then((r) => r.json())
      .then((h: ModelHealth) => setHealth(h))
      .catch(() => setHealth(null));
  }, []);

  /** Switching how the question is asked re-asks it; the structure below is unchanged. */
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    if (result) void requestReasoning(lastQuery, next);
  };

  const focus: ViewerFocus | null = result
    ? {
        uniprotResnum: result.numbering.uniprotResnum,
        label: `${result.input.canonical} (structure ${result.numbering.uniprotResnum})`,
        pocketUniprotResnums: result.pocket.uniprotResnums,
        center: result.structure.drug.residueCenter,
      }
    : null;

  const viewerFocus = view === "triage" ? (triageFocus ?? focus) : focus;

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          AMR Resistance Copilot
        </h1>
        <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-400">
          Structure-grounded interpretation of antimicrobial-resistance mutations. Locates the
          mutation on the drug target and measures its relationship to the drug-binding site —
          including for mutations no catalogue has seen.
        </p>
      </header>

      <nav className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-slate-700">
          <ViewButton active={view === "single"} onClick={() => setView("single")}>
            One mutation
          </ViewButton>
          <ViewButton active={view === "triage"} onClick={() => setView("triage")}>
            Batch triage
          </ViewButton>
          <ViewButton active={view === "eval"} onClick={() => setView("eval")}>
            Eval
          </ViewButton>
        </div>
        <span className="text-xs text-slate-500">{VIEW_BLURB[view]}</span>
      </nav>

      {/* Both working views stay mounted. Switching to the eval and back during a demo must
          not discard a triage table whose mechanisms took a minute of local inference to
          fill in, and it keeps the viewer from re-parsing the structure on every switch. */}
      <div
        className={`mt-6 grid-cols-1 gap-6 ${view === "eval" ? "hidden" : "grid"} ${
          view === "single" ? "lg:grid-cols-[440px_1fr]" : "lg:grid-cols-[minmax(0,1fr)_430px]"
        }`}
      >
        <section className={view === "triage" ? "min-w-0" : "hidden"}>
          <TriagePanel
            modelAvailable={health ? health.available && health.modelPresent : true}
            onSelect={setTriageFocus}
            onOpenSingle={(mutation) => {
              setInput(mutation);
              setView("single");
              void analyse(mutation);
            }}
          />
        </section>

        <section className={view === "single" ? "flex flex-col gap-5" : "hidden"}>
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

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-slate-500">Reasoning</span>
            <div className="flex overflow-hidden rounded-lg border border-slate-700">
              <ModeButton active={mode === "pipeline"} onClick={() => switchMode("pipeline")}>
                Pipeline
              </ModeButton>
              <ModeButton active={mode === "agent"} onClick={() => switchMode("agent")}>
                Agent + tool trace
              </ModeButton>
            </div>
            <span className="text-xs text-slate-500">
              {mode === "pipeline"
                ? "one call over precomputed features"
                : "the model measures the structure itself · ~1 min"}
            </span>
          </div>

          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-2.5 text-sm text-red-300">
              {error}
            </p>
          )}

          {result && (
            <ResultPanel
              result={result}
              mode={mode}
              reasoning={reasoning}
              agent={agent}
              reasoningBusy={reasoningBusy}
              reasoningError={reasoningError}
              health={health}
            />
          )}
        </section>

        <section className="min-h-[520px] lg:sticky lg:top-6 lg:h-[calc(100vh-13rem)]">
          <StructureViewer focus={viewerFocus} />
        </section>
      </div>

      {/* Mounted alongside the others, for the same reason: scoring the model over the golden
          set costs a couple of minutes of local inference, and switching tabs to point at the
          structure must not throw it away. It also makes the tab open instantly. */}
      <div className={view === "eval" ? "mt-6" : "hidden"}>
        <EvalPanel />
      </div>
    </main>
  );
}

function ResultPanel({
  result,
  mode,
  reasoning,
  agent,
  reasoningBusy,
  reasoningError,
  health,
}: {
  result: AnalysisResult;
  mode: Mode;
  reasoning: MechanisticReasoning | null;
  agent: AgentRun | null;
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
        mode={mode}
        reasoning={reasoning}
        agent={agent}
        busy={reasoningBusy}
        error={reasoningError}
        health={health}
        catalogue={catalogue}
        drug={structure.drug}
      />

      {/* The stretch. Everything above is measured; this one predicts, and says so. */}
      <AffinityPanel mutation={result.input.canonical} />

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
          note={`${structure.burial.band}, ${ordinal(structure.burial.percentile)} percentile`}
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
  mode,
  reasoning,
  agent,
  busy,
  error,
  health,
  catalogue,
  drug,
}: {
  mode: Mode;
  reasoning: MechanisticReasoning | null;
  agent: AgentRun | null;
  busy: boolean;
  error: string | null;
  health: ModelHealth | null;
  catalogue: CatalogueVerdict;
  drug: AnalysisResult["structure"]["drug"];
}) {
  // Both modes answer in the same shape, so the panel below them is the same panel.
  const answer = mode === "agent" ? agent?.reasoning ?? null : reasoning?.reasoning ?? null;
  const prose = mode === "agent" ? agent?.text ?? null : reasoning?.text ?? null;
  const run = mode === "agent" ? agent : reasoning;
  const notes = run?.notes ?? [];
  const modelName = run?.model ?? health?.model ?? "qwen3:8b";

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-slate-400">
          Mechanistic hypothesis{mode === "agent" ? " · agent" : ""}
        </p>
        <p className="font-mono text-[11px] text-slate-500">
          {modelName} · local
          {run ? ` · ${(run.latencyMs / 1000).toFixed(1)}s` : ""}
          {agent && mode === "agent" ? ` · ${agent.trace.length} tool calls` : ""}
        </p>
      </div>

      {busy && <Thinking mode={mode} />}

      {!busy && error && (
        <div className="mt-2 rounded-lg border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs leading-relaxed text-amber-300">
          {error}
          <span className="mt-1 block text-amber-400/70">
            The measurements above are computed locally and stand without the model.
          </span>
        </div>
      )}

      {!busy && !error && answer && (
        <div className="mt-2.5 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
                LIKELIHOOD_STYLES[answer.resistanceLikelihood]
              }`}
            >
              {answer.resistanceLikelihood} resistance likelihood
            </span>
          </div>
          <p className="leading-relaxed text-slate-200">{answer.mechanismHypothesis}</p>
          <Field label="Caveat">{answer.confidenceCaveat}</Field>
          <Field label="What would confirm it">{answer.whatWouldConfirm}</Field>
          {(() => {
            const note = disagreementNote(catalogue, drug, answer.resistanceLikelihood);
            return note ? (
              <p className="rounded-lg border border-amber-800 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-300">
                <span className="font-medium uppercase tracking-wide">Disagreement · </span>
                {note}
              </p>
            ) : null;
          })()}
        </div>
      )}

      {!busy && !error && prose && (
        <p className="mt-2.5 whitespace-pre-wrap leading-relaxed text-slate-200">{prose}</p>
      )}

      {!busy && !error && mode === "agent" && agent && <ToolTrace agent={agent} />}

      {!busy && !error && mode === "pipeline" && reasoning && (
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
        </details>
      )}

      {!busy && !error && notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-amber-400/80">
          {notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The trace is the point of the agent mode. The model started with a mutation string and
 * no measurements, so every number in the answer above arrived through one of these calls,
 * and anything it could not measure it could not claim.
 */
function ToolTrace({ agent }: { agent: AgentRun }) {
  return (
    <details open className="mt-3 border-t border-slate-800 pt-2">
      <summary className="cursor-pointer text-xs text-slate-500">
        Tool trace — {agent.trace.length} call{agent.trace.length === 1 ? "" : "s"} over{" "}
        {agent.turns} turn{agent.turns === 1 ? "" : "s"}
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        The model was given the mutation and nothing else. It chose this sequence itself, out
        of{" "}
        <span className="font-mono text-slate-400">{agent.toolsOffered.join(", ")}</span>.
      </p>
      <ol className="mt-2 flex flex-col gap-1.5">
        {agent.trace.map((call) => (
          <TraceRow key={call.step} call={call} />
        ))}
      </ol>
    </details>
  );
}

function TraceRow({ call }: { call: ToolCallRecord }) {
  return (
    <li className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-1.5">
      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        <span className="text-slate-600">{call.step}</span>
        <span className={call.ok ? "text-teal-300" : "text-amber-300"}>{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500">
          {JSON.stringify(call.arguments)}
        </span>
        <span className="text-slate-600">{call.durationMs}ms</span>
      </div>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-slate-400">
        {JSON.stringify(call.result)}
      </pre>
    </li>
  );
}

const VIEW_BLURB: Record<View, string> = {
  single: "one mutation, measured and explained",
  triage: "a whole isolate, ranked",
  eval: "does the ranking hold up against labelled ground truth",
};

function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs transition ${
        active ? "bg-slate-100 text-slate-900" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 text-xs transition ${
        active ? "bg-teal-500 text-slate-950" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

/** An 8B model on a laptop takes ~10s, and a tool loop six times that; show the clock. */
function Thinking({ mode }: { mode: Mode }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-400" />
      {mode === "agent"
        ? "Measuring the structure, one tool call at a time…"
        : "Reasoning over the measurements…"}{" "}
      {seconds}s
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
