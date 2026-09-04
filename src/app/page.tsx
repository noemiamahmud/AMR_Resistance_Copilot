"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import AffinityPanel from "@/components/AffinityPanel";
import { IndeterminateBar, ResultSkeleton, Wordmark } from "@/components/chrome";
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

/** What /api/targets returns: whatever is bundled in scripts/targets.json. */
export interface TargetSummary {
  id: string; gene: string; drug: string; drugClass: string; organism: string;
  proteinName: string; blurb: string; uniprotAccession: string; complexPdbId: string;
  ligandCode: string; structureFile: string; ligandPoseFile: string;
  clinicalReference: string; clinicalToUniprotOffset: number; clinicalLength: number;
  hasGoldenSet: boolean;
}

import { TARGETS } from "@/lib/targets";

/**
 * The examples are data, not markup: each target in scripts/targets.json carries its own
 * tour, and each entry says what it is meant to demonstrate. Adding a target adds its
 * examples with it.
 */
const HERO_TARGET = TARGETS[0];
const HERO_MUTATION = `${HERO_TARGET.gene} ${HERO_TARGET.heroMutation}`;

/** The viewer needs the ligand's PDB residue name to style it; the server knows it. */
function ligandCodeFor(targets: TargetSummary[], id: string): string {
  return targets.find((t) => t.id === id)?.ligandCode ?? "LIG";
}

const KIND_STYLE: Record<string, string> = {
  catalogued: "border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200",
  novel: "border-fuchsia-800 text-fuchsia-300 hover:border-fuchsia-600 hover:text-fuchsia-200",
  distal: "border-amber-800 text-amber-300 hover:border-amber-600 hover:text-amber-200",
};

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
  const [targets, setTargets] = useState<TargetSummary[]>([]);
  const [targetId, setTargetId] = useState<string>(HERO_TARGET.id);
  const [triageFocus, setTriageFocus] = useState<ViewerFocus | null>(null);

  const [mode, setMode] = useState<Mode>("pipeline");
  const [reasoning, setReasoning] = useState<MechanisticReasoning | null>(null);
  const [agent, setAgent] = useState<AgentRun | null>(null);
  const [reasoningError, setReasoningError] = useState<string | null>(null);
  const [reasoningBusy, setReasoningBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState(HERO_MUTATION);
  const [health, setHealth] = useState<ModelHealth | null>(null);
  const reasoningAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const apply = () => {
      document.title = VIEW_DOCUMENT_TITLE[view];
    };
    apply();
    // Next.js metadata can rewrite <title> after hydration; re-apply once the paint settles.
    const id = window.setTimeout(apply, 0);
    return () => window.clearTimeout(id);
  }, [view]);

  /** Ask the local model for a mechanism, cancelling any question still in flight. */
  const requestReasoning = useCallback(async (mutation: string, nextMode: Mode, target: string) => {
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
        body: JSON.stringify({ mutation, target }),
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

  /** `target` is passed rather than read from state so that switching target can analyse
   *  the new one immediately, instead of one render behind. */
  const analyse = useCallback(
    async (mutation: string, nextMode: Mode = mode, target: string = targetId) => {
      setBusy(true);
      setError(null);
      setLastQuery(mutation);
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mutation, target }),
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
          void requestReasoning(mutation, nextMode, target);
        }
      } catch {
        setError("Could not reach the analysis service.");
        setResult(null);
      } finally {
        setBusy(false);
      }
    },
    [mode, requestReasoning, targetId],
  );

  // The safety net: the hero case is analysed on load, entirely from local files.
  useEffect(() => {
    void analyse(HERO_MUTATION, "pipeline");
    // Load-time only; switching mode later re-runs through switchMode, not through here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/targets")
      .then((r) => r.json())
      .then((b: { targets: TargetSummary[] }) => setTargets(b.targets))
      .catch(() => setTargets([]));
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
    if (result) void requestReasoning(lastQuery, next, targetId);
  };

  const focus: ViewerFocus | null = result
    ? {
        uniprotResnum: result.numbering.uniprotResnum,
        label: `${result.input.canonical} (structure ${result.numbering.uniprotResnum})`,
        pocketUniprotResnums: result.pocket.uniprotResnums,
        center: result.structure.drug.residueCenter,
        structureFile: result.target.structureFile,
        ligandPoseFile: result.target.ligandPoseFile,
        ligandCode: ligandCodeFor(targets, result.target.id),
        drug: result.target.drug,
        gene: result.target.gene,
        proteinName: result.target.proteinName,
        uniprotAccession: result.target.uniprotAccession,
        pdbId: result.pocket.pdbId,
      }
    : null;

  const active = targets.find((t) => t.id === targetId) ?? null;
  const currentTarget = TARGETS.find((t) => t.id === targetId) ?? HERO_TARGET;

  /** Selecting a different target re-analyses its own hero case rather than stranding the
   *  previous gene's mutation against a structure that does not contain that residue. */
  const switchTarget = (next: string) => {
    if (next === targetId) return;
    const t = TARGETS.find((x) => x.id === next);
    setTargetId(next);
    if (t) {
      const mutation = `${t.gene} ${t.heroMutation}`;
      setInput(mutation);
      void analyse(mutation, mode, next);
    }
  };

  const viewerFocus = view === "triage" ? (triageFocus ?? focus) : focus;

  return (
    <main className="mx-auto min-h-screen max-w-[1500px] px-8 py-8">
      <header className="flex items-start gap-4">
        <Wordmark />
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-slate-50">
            AMR Resistance Copilot
          </h1>
          <p className="mt-2 max-w-3xl text-base leading-relaxed text-slate-400">
            Structure-grounded interpretation of antimicrobial-resistance mutations. Locates the
            mutation on the drug target and measures its relationship to the drug-binding site —
            including for mutations no catalogue has seen.
          </p>
        </div>
      </header>

      <nav className="mt-8 flex flex-wrap items-center gap-4">
        <div className="flex overflow-hidden rounded-lg border border-slate-700/80">
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
        <span className="text-sm text-slate-500">{VIEW_BLURB[view]}</span>
      </nav>

      {/* Both working views stay mounted. Switching to the eval and back during a demo must
          not discard a triage table whose mechanisms took a minute of local inference to
          fill in, and it keeps the viewer from re-parsing the structure on every switch. */}
      <div
        className={`mt-8 grid-cols-1 gap-8 ${view === "eval" ? "hidden" : "grid"} ${
          view === "single" ? "lg:grid-cols-[440px_1fr]" : "lg:grid-cols-[minmax(0,1fr)_430px]"
        }`}
      >
        <section className={view === "triage" ? "min-h-0 min-w-0 overflow-y-auto lg:max-h-[calc(100vh-12rem)]" : "hidden"}>
          {/* Keyed by target: switching gene strands the old isolate against a structure
              that does not contain those residues, so the panel is rebuilt rather than
              patched up field by field. */}
          <TriagePanel
            key={targetId}
            targetId={targetId}
            modelAvailable={health ? health.available && health.modelPresent : true}
            onSelect={setTriageFocus}
            onOpenSingle={(mutation) => {
              setInput(mutation);
              setView("single");
              void analyse(mutation);
            }}
          />
        </section>

        <section className={view === "single" ? "flex min-h-0 flex-col gap-8 overflow-y-auto lg:max-h-[calc(100vh-12rem)]" : "hidden"}>
          <TargetPicker targets={targets} active={targetId} onChange={switchTarget} />

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void analyse(input);
            }}
            className="flex flex-col gap-2"
          >
            <label htmlFor="mutation" className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
              Gene and mutation
            </label>
            <div className="flex gap-2">
              <input
                id="mutation"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="rpoB S450L"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2.5 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-teal-400"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-teal-500 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-teal-400 disabled:opacity-50"
              >
                {busy ? "Analysing…" : "Analyse"}
              </button>
            </div>
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs leading-relaxed text-slate-500">
                Cases worth trying on {active?.gene ?? HERO_TARGET.gene} — hover any button for
                what it demonstrates. <span className="text-fuchsia-400">Pink</span> is absent
                from the catalogue, which is the case this tool exists for;{" "}
                <span className="text-amber-400">amber</span> is one it gets wrong.
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {currentTarget.examples.map((ex) => {
                  const full = `${currentTarget.gene} ${ex.mutation}`;
                  return (
                    <button
                      key={ex.mutation}
                      type="button"
                      title={ex.why}
                      onClick={() => {
                        setInput(full);
                        void analyse(full);
                      }}
                      className={`rounded-md border px-2.5 py-1 font-mono text-xs transition ${KIND_STYLE[ex.kind]}`}
                    >
                      {ex.mutation}
                    </button>
                  );
                })}
              </div>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">Reasoning</span>
            <div className="flex overflow-hidden rounded-lg border border-slate-700/80">
              <ModeButton active={mode === "pipeline"} onClick={() => switchMode("pipeline")}>
                Pipeline
              </ModeButton>
              <ModeButton active={mode === "agent"} onClick={() => switchMode("agent")}>
                Agent + tool trace
              </ModeButton>
            </div>
            <span className="text-sm text-slate-500">
              {mode === "pipeline"
                ? "one call over precomputed features"
                : "the model measures the structure itself · ~1 min"}
            </span>
          </div>

          {error && (
            <p className="rounded-lg border border-red-900/80 bg-red-950/50 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          )}

          {busy && !result && <ResultSkeleton />}

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

        <section className="min-h-[520px] lg:sticky lg:top-8 lg:h-[calc(100vh-12rem)]">
          <StructureViewer focus={viewerFocus} />
        </section>
      </div>

      {/* Mounted alongside the others, for the same reason: scoring the model over the golden
          set costs a couple of minutes of local inference, and switching tabs to point at the
          structure must not throw it away. It also makes the tab open instantly. */}
      <div className={view === "eval" ? "mt-8" : "hidden"}>
        <EvalPanel targetId={targetId} />
      </div>
    </main>
  );
}

/**
 * Which drug target the question is about. This is the abstraction made visible: the list
 * comes from the server, which reads scripts/targets.json, so a new target appears here
 * without a line of UI changing. Each option states the gene, the drug it is up against,
 * and one sentence of why that pairing matters, because "rpoB + rifampicin" means nothing
 * to a reader who does not already know the field.
 */
function TargetPicker({
  targets,
  active,
  onChange,
}: {
  targets: TargetSummary[];
  active: string;
  onChange: (id: string) => void;
}) {
  const current = targets.find((t) => t.id === active) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="target" className="text-xs font-medium uppercase tracking-[0.14em] text-slate-500">
        Drug target — the protein the antibiotic has to hit
      </label>
      <select
        id="target"
        value={active}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-teal-400"
      >
        {(targets.length ? targets : []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.gene} + {t.drug} ({t.drugClass})
          </option>
        ))}
        {targets.length === 0 && <option>loading…</option>}
      </select>
      {current && (
        <div className="px-1 py-1">
          <p className="text-sm leading-relaxed text-slate-400">{current.blurb}</p>
          <p className="mt-2 font-mono text-[11px] leading-relaxed text-slate-600">
            {current.proteinName} · {current.organism} · AlphaFold {current.uniprotAccession} ·
            drug pose from PDB {current.complexPdbId} ({current.ligandCode}) ·{" "}
            {current.clinicalToUniprotOffset === 0
              ? "catalogue and structure numbering agree"
              : `catalogue numbering is ${current.clinicalToUniprotOffset} behind the structure`}
          </p>
        </div>
      )}
    </div>
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
    <div className="flex flex-col gap-8 text-sm">
      <div className="flex flex-col gap-4">
      <div
        className={`rounded-2xl border border-l-[3px] px-6 py-5 ${
          contact
            ? "border-amber-800/70 border-l-amber-400 bg-amber-950/35"
            : "border-slate-800/80 border-l-teal-400 bg-slate-900/50"
        }`}
      >
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">Structural call</p>
        <p className="font-display mt-2 text-xl leading-snug text-slate-50">{result.headline}</p>
      </div>

      {!result.validation.matchesInput && (
        <p className="rounded-lg border border-amber-800/70 bg-amber-950/35 px-4 py-2.5 text-sm leading-relaxed text-amber-200">
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
      </div>

      {/* The stretch. Everything above is measured; this one predicts, and says so. */}
      <AffinityPanel mutation={result.input.canonical} targetId={result.target.id} />

      <div className="flex flex-col gap-4">
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
        <p className="text-sm leading-relaxed text-slate-300">{substitution.summary}</p>
        <p className="mt-1 text-xs text-slate-500">
          {substitution.wildType.name} → {substitution.mutant.name}; hydropathy shift{" "}
          {substitution.hydropathyShift > 0 ? "+" : ""}
          {substitution.hydropathyShift}
        </p>
      </Card>

      <Card title="Numbering">
        <p className="text-sm leading-relaxed text-slate-400">{numbering.explanation}</p>
      </Card>
      </div>

      <details className="px-1">
        <summary className="cursor-pointer text-xs uppercase tracking-[0.14em] text-slate-500">
          Provenance
        </summary>
        <ul className="mt-2 space-y-1 pl-1 text-xs leading-relaxed text-slate-500">
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
      className={`rounded-xl border px-5 py-4 ${
        known
          ? "border-slate-800/80 bg-slate-900/45"
          : "border-fuchsia-800/70 bg-fuchsia-950/25"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-[0.12em] ${
            known ? "bg-slate-700 text-slate-200" : "bg-fuchsia-700 text-fuchsia-50"
          }`}
        >
          {known ? `In ${catalogue.name.split(" ")[0]}` : "Not in the catalogue"}
        </span>
        <span className="font-mono tabular-nums text-[11px] text-slate-500">
          {catalogue.entryCount} substitutions · {catalogue.residuesCovered} residues
        </span>
      </div>

      <p className="mt-3 text-base leading-relaxed text-slate-100">{catalogue.catalogueOnly.verdict}</p>

      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        {known
          ? "The catalogue already covers this one. The structural call above is an independent read of the same mutation — the same reasoning that has to stand alone when the catalogue is silent."
          : "This is where a catalogue stops, and surveillance keeps producing mutations no catalogue has seen. Everything above and below is measured from the structure, so the call still gets made."}
      </p>

      {!known && sameResidue.length > 0 && (
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          It does list {sameResidue.length} other substitution
          {sameResidue.length === 1 ? "" : "s"} at residue {residue}:{" "}
          <span className="font-mono text-slate-300">{shown.join(", ")}</span>
          {sameResidue.length > shown.length ? `, and ${sameResidue.length - shown.length} more` : ""}
          {" — but not this one."}
        </p>
      )}

      {!known && nearby.length > 0 && (
        <p className="mt-2 text-sm leading-relaxed text-slate-400">
          Catalogued resistance residues within 8 Å of it:{" "}
          <span className="font-mono text-slate-300">
            {nearby.map((n) => `${n.aa}${n.clinicalResnum} ${n.distanceAngstroms} Å`).join(" · ")}
          </span>
          . Context only — this is catalogue knowledge, and it is kept out of what the model sees.
        </p>
      )}

      {known && catalogue.exactMatch && (
        <p className="mt-3 font-mono text-[11px] text-slate-500">
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
    <div className="rounded-xl border border-slate-800/80 bg-slate-900/40 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-display text-base text-slate-100">
          Mechanistic hypothesis{mode === "agent" ? " · agent" : ""}
        </p>
        <p className="font-mono tabular-nums text-[11px] text-slate-500">
          {modelName} · local
          {run ? ` · ${(run.latencyMs / 1000).toFixed(1)}s` : ""}
          {agent && mode === "agent" ? ` · ${agent.trace.length} tool calls` : ""}
        </p>
      </div>

      {busy && <Thinking mode={mode} />}

      {!busy && error && (
        <div className="mt-3 rounded-lg border border-amber-900/70 bg-amber-950/35 px-4 py-2.5 text-sm leading-relaxed text-amber-200">
          {error}
          <span className="mt-1 block text-amber-400/70">
            The measurements above are computed locally and stand without the model.
          </span>
        </div>
      )}

      {!busy && !error && answer && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span
              className={`rounded border px-2 py-0.5 text-xs font-medium uppercase tracking-[0.12em] ${
                LIKELIHOOD_STYLES[answer.resistanceLikelihood]
              }`}
            >
              {answer.resistanceLikelihood} resistance likelihood
            </span>
          </div>
          <p className="text-base leading-relaxed text-slate-100">{answer.mechanismHypothesis}</p>
          <Field label="Caveat">{answer.confidenceCaveat}</Field>
          <Field label="What would confirm it">{answer.whatWouldConfirm}</Field>
          {(() => {
            const note = disagreementNote(catalogue, drug, answer.resistanceLikelihood);
            return note ? (
              <p className="rounded-lg border border-amber-800/70 bg-amber-950/25 px-4 py-2.5 text-sm leading-relaxed text-amber-200">
                <span className="font-medium uppercase tracking-[0.12em]">Disagreement · </span>
                {note}
              </p>
            ) : null;
          })()}
        </div>
      )}

      {!busy && !error && prose && (
        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-slate-200">{prose}</p>
      )}

      {!busy && !error && mode === "agent" && agent && <ToolTrace agent={agent} />}

      {!busy && !error && mode === "pipeline" && reasoning && (
        <details className="mt-4 border-t border-slate-800/80 pt-3">
          <summary className="cursor-pointer text-xs text-slate-500">
            Evidence handed to the model
          </summary>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            The model sees only these measurements. The catalogue verdict is deliberately withheld,
            so its answer cannot be a memory of a famous mutation.
          </p>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-slate-950/70 p-3 font-mono text-[11px] leading-relaxed text-slate-400">
            {JSON.stringify(reasoning.features, null, 2)}
          </pre>
        </details>
      )}

      {!busy && !error && notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-amber-400/80">
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
    <details open className="mt-4 border-t border-slate-800/80 pt-3">
      <summary className="cursor-pointer text-xs text-slate-500">
        Tool trace — {agent.trace.length} call{agent.trace.length === 1 ? "" : "s"} over{" "}
        {agent.turns} turn{agent.turns === 1 ? "" : "s"}
      </summary>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        The model was given the mutation and nothing else. It chose this sequence itself, out
        of{" "}
        <span className="font-mono text-slate-400">{agent.toolsOffered.join(", ")}</span>.
      </p>
      <ol className="mt-3 flex flex-col gap-2">
        {agent.trace.map((call) => (
          <TraceRow key={call.step} call={call} />
        ))}
      </ol>
    </details>
  );
}

function TraceRow({ call }: { call: ToolCallRecord }) {
  return (
    <li className="rounded-lg bg-slate-950/50 px-3 py-2">
      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        <span className="tabular-nums text-slate-600">{call.step}</span>
        <span className={call.ok ? "text-teal-300" : "text-amber-300"}>{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-slate-500">
          {JSON.stringify(call.arguments)}
        </span>
        <span className="tabular-nums text-slate-600">{call.durationMs}ms</span>
      </div>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-slate-400">
        {JSON.stringify(call.result)}
      </pre>
    </li>
  );
}

const VIEW_DOCUMENT_TITLE: Record<View, string> = {
  single: "One mutation · AMR Resistance Copilot",
  triage: "Batch triage · AMR Resistance Copilot",
  eval: "Eval · AMR Resistance Copilot",
};

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
      className={`px-3.5 py-2 text-sm transition ${
        active ? "bg-slate-100 font-medium text-slate-900" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
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
      className={`px-3 py-1.5 text-sm transition ${
        active ? "bg-teal-500 font-medium text-slate-950" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
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
    <IndeterminateBar
      label={
        mode === "agent"
          ? "Measuring the structure, one tool call at a time…"
          : "Reasoning over the measurements…"
      }
      hint={
        mode === "agent"
          ? "Local model with a tool loop — typically around a minute."
          : "Local qwen3:8b over the measurements already on this page."
      }
      elapsed={seconds}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-300">{children}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-1 py-1">
      <p className="font-display text-base text-slate-100">{title}</p>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-800/50 py-2 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-right">
        <span className="font-mono tabular-nums text-slate-100">{value}</span>
        {note && <span className="ml-2 text-xs text-slate-500">{note}</span>}
      </span>
    </div>
  );
}
