"use client";

import { useEffect, useRef, useState } from "react";

const CDN = "https://3Dmol.org/build/3Dmol-min.js";

export interface ViewerFocus {
  /** Residue number in the structure's own (UniProt) numbering. */
  uniprotResnum: number;
  label: string;
  pocketUniprotResnums: number[];
  /** CA coordinate of the mutated residue; 3Dmol anchors labels to a point. */
  center: { x: number; y: number; z: number };
  /** Which structure and drug pose to draw. Different targets, different files. */
  structureFile: string;
  ligandPoseFile: string;
  ligandCode: string;
  drug: string;
}

let scriptPromise: Promise<void> | null = null;

function load3Dmol(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.$3Dmol) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = CDN;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Could not load 3Dmol.js from the CDN."));
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export default function StructureViewer({ focus }: { focus: ViewerFocus | null }) {
  // Which files are loaded is now part of the focus, so switching target reloads the model.
  const structureFile = focus?.structureFile ?? null;
  const ligandPoseFile = focus?.ligandPoseFile ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ReturnType<NonNullable<Window["$3Dmol"]>["createViewer"]> | null>(null);
  const [assets, setAssets] = useState<{ pdb: string; ligand: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Fetch the structure and the drug pose for whichever target is selected.
  useEffect(() => {
    if (!structureFile || !ligandPoseFile) return;
    let cancelled = false;
    Promise.all([
      fetch(`/${structureFile}`).then((r) => r.text()),
      fetch(`/${ligandPoseFile}`).then((r) => r.text()),
    ])
      .then(([pdb, ligand]) => {
        if (!cancelled) setAssets({ pdb, ligand });
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the bundled structure files.");
      });
    return () => {
      cancelled = true;
    };
  }, [structureFile, ligandPoseFile]);

  // Create the viewer once the library and the assets are both in.
  useEffect(() => {
    if (!assets || !containerRef.current) return;
    let cancelled = false;

    load3Dmol()
      .then(() => {
        if (cancelled || !containerRef.current || !window.$3Dmol) return;
        const viewer = window.$3Dmol.createViewer(containerRef.current, {
          backgroundColor: "#0b1020",
        });
        viewer.addModel(assets.pdb, "pdb");
        viewer.addModel(assets.ligand, "pdb");
        viewerRef.current = viewer;
        setReady(true);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
      viewerRef.current?.clear();
      viewerRef.current = null;
      // Switching target swaps the model out; until the new one is built there is nothing
      // to style, and a stale `ready` would let the focus effect draw into a dead viewer.
      setReady(false);
    };
  }, [assets]);

  // Re-style whenever the focus changes.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !ready) return;

    viewer.removeAllLabels();
    viewer.removeAllSurfaces();

    // Base: a dim cartoon so the pocket reads as the subject, not the whole 1178-residue chain.
    viewer.setStyle({}, { cartoon: { color: "#1e2a4a", opacity: 0.55 } });

    // The drug, always shown.
    if (focus) {
      viewer.setStyle(
        { resn: focus.ligandCode },
        { stick: { colorscheme: "yellowCarbon", radius: 0.22 } },
      );
    }

    if (focus) {
      // Pocket residues in teal sticks.
      viewer.addStyle(
        { resi: focus.pocketUniprotResnums },
        { stick: { color: "#2dd4bf", radius: 0.13 } },
      );
      viewer.addStyle({ resi: focus.pocketUniprotResnums }, { cartoon: { color: "#2dd4bf" } });

      // The mutated residue in red, thicker, with a label.
      viewer.addStyle(
        { resi: focus.uniprotResnum },
        { stick: { color: "#ef4444", radius: 0.3 }, sphere: { color: "#ef4444", radius: 0.45 } },
      );
      viewer.addLabel(focus.label, {
        position: focus.center,
        backgroundColor: "#ef4444",
        backgroundOpacity: 0.9,
        fontColor: "white",
        fontSize: 13,
        borderThickness: 0,
        inFront: true,
      });

      // Frame the drug and its contact shell rather than the whole subunit.
      viewer.zoomTo({ or: [{ resn: focus.ligandCode }, { resi: [focus.uniprotResnum] }] });
      viewer.zoom(0.6);
    } else {
      viewer.zoomTo();
    }

    viewer.render();
  }, [focus, ready]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-slate-800 bg-[#0b1020]">
      <div ref={containerRef} className="absolute inset-0" />
      {(!ready || error) && (
        <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-400">
          {error ?? "Loading structure…"}
        </div>
      )}
      {ready && !error && (
        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-lg bg-slate-950/70 px-3 py-2 text-xs text-slate-300">
          <Legend color="#ef4444" label="mutated residue" />
          <Legend color="#2dd4bf" label={`${focus?.drug ?? "drug"}-contact residues`} />
          <Legend color="#eab308" label={focus?.drug ?? "drug"} />
        </div>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
