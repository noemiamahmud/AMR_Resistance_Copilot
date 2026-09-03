"use client";

import { useCallback, useEffect, useState } from "react";

import StructureViewer, { ViewerFocus } from "@/components/StructureViewer";
import type { AnalysisResult } from "@/lib/analysis";

const HERO_MUTATION = "rpoB S450L";
const EXAMPLES = ["rpoB S450L", "rpoB H445Y", "rpoB D435V", "rpoB I491F", "rpoB E592D"];

export default function Home() {
  const [input, setInput] = useState(HERO_MUTATION);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const analyse = useCallback(async (mutation: string) => {
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
      } else {
        setResult(body as AnalysisResult);
      }
    } catch {
      setError("Could not reach the analysis service.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, []);

  // The safety net: the hero case is analysed on load, entirely from local files.
  useEffect(() => {
    void analyse(HERO_MUTATION);
  }, [analyse]);

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

        {result && <ResultPanel result={result} />}
      </section>

      <section className="min-h-[520px] lg:h-[calc(100vh-3rem)] lg:sticky lg:top-6">
        <StructureViewer focus={focus} />
      </section>
    </main>
  );
}

function ResultPanel({ result }: { result: AnalysisResult }) {
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

      <Card title="Catalogue lookup">
        {catalogue.known ? (
          <div className="text-slate-300">
            <p>
              <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-medium text-slate-200">
                KNOWN
              </span>{" "}
              in {catalogue.name}.
            </p>
            <p className="mt-1.5 text-xs text-slate-400">
              {catalogue.exactMatch?.variantType} · evidence {catalogue.exactMatch?.evidence} · cited{" "}
              {catalogue.exactMatch?.citation}
            </p>
          </div>
        ) : (
          <div className="text-slate-300">
            <p>
              <span className="rounded bg-fuchsia-800 px-1.5 py-0.5 text-xs font-medium text-fuchsia-100">
                NOVEL
              </span>{" "}
              — not in {catalogue.name}.
            </p>
            {catalogue.sameResidueEntries.length > 0 && (
              <p className="mt-1.5 text-xs text-slate-400">
                The catalogue does list other substitutions at residue {numbering.clinicalResnum}:{" "}
                {catalogue.sameResidueEntries.map((e) => e.mutation).join(", ")}.
              </p>
            )}
          </div>
        )}
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
