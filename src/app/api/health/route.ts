import { promises as fs } from "fs";
import path from "path";

import { NextResponse } from "next/server";

import { boltzConfigured } from "@/lib/boltz";
import { health as ollamaHealth } from "@/lib/ollama";
import { TARGETS } from "@/lib/targets";

/**
 * One request that answers "what is actually working right now".
 *
 * The app has four dependencies with genuinely different failure modes - bundled files, a
 * local model, an optional cloud GPU, and a CDN for the 3D viewer - and each degrades to
 * something different rather than taking the page down. This endpoint reports each one so
 * the System view can say which parts are live, which are degraded, and what the user will
 * still get either way, instead of leaving them to infer it from a spinner.
 */

export type Status = "ok" | "degraded" | "down";

export interface CheckResult {
  id: string;
  label: string;
  /** What this component is for, in one sentence. */
  purpose: string;
  status: Status;
  detail: string;
  /** What the app does when this is unavailable. */
  fallback: string;
  required: boolean;
}

async function statOf(rel: string): Promise<{ ok: boolean; bytes: number }> {
  try {
    const s = await fs.stat(path.join(process.cwd(), "public", rel));
    return { ok: true, bytes: s.size };
  } catch {
    return { ok: false, bytes: 0 };
  }
}

export async function GET() {
  // --- bundled data, per target -------------------------------------------------
  const targetChecks = await Promise.all(
    TARGETS.map(async (t) => {
      const files = [t.structureFile, t.ligandPoseFile, t.pocketFile, t.catalogueFile];
      if (t.goldenSetFile) files.push(t.goldenSetFile);
      const stats = await Promise.all(files.map(statOf));
      const missing = files.filter((_, i) => !stats[i].ok);
      const bytes = stats.reduce((s, x) => s + x.bytes, 0);
      return {
        id: t.id,
        gene: t.gene,
        drug: t.drug,
        status: (missing.length === 0 ? "ok" : "down") as Status,
        files: files.length,
        missing,
        megabytes: +(bytes / 1e6).toFixed(1),
        hasGoldenSet: Boolean(t.goldenSetFile),
      };
    }),
  );

  const dataOk = targetChecks.every((t) => t.status === "ok");
  const model = await ollamaHealth();
  const affinityCache = await statOf("data/affinity-cache.json");

  const checks: CheckResult[] = [
    {
      id: "structures",
      label: "Bundled structures and catalogues",
      purpose:
        "The coordinates, drug poses, contact-residue sets and CARD catalogues every " +
        "measurement is taken from. Read off local disk, so no network is involved.",
      status: dataOk ? "ok" : "down",
      detail: dataOk
        ? `${targetChecks.length} targets, all files present (${targetChecks
            .reduce((s, t) => s + t.megabytes, 0)
            .toFixed(1)} MB).`
        : `Missing: ${targetChecks.flatMap((t) => t.missing).join(", ")}`,
      fallback: "None. Without these the app cannot measure anything.",
      required: true,
    },
    {
      id: "ollama",
      label: `Local language model (${model.model})`,
      purpose:
        "Turns the measurements into a written mechanism, and drives the agent's tool " +
        "calls. Runs on this machine through Ollama - no data leaves it.",
      status: model.available && model.modelPresent ? "ok" : model.available ? "degraded" : "down",
      detail: model.available
        ? model.modelPresent
          ? `Reachable at ${model.host}, model pulled.`
          : `Reachable at ${model.host}, but "${model.model}" is not pulled. Run: ollama pull ${model.model}`
        : `No server at ${model.host}. Run: ollama serve`,
      fallback:
        "Every structural number, the catalogue verdict, the triage ranking and the eval " +
        "still work. Only the written hypothesis is missing.",
      required: false,
    },
    {
      id: "boltz",
      label: "Boltz-2 affinity (optional, cloud)",
      purpose:
        "Co-folds the protein with the drug and predicts a binding affinity for wild type " +
        "versus mutant. The only component that predicts rather than measures.",
      status: affinityCache.ok ? "ok" : boltzConfigured() ? "degraded" : "down",
      detail: affinityCache.ok
        ? `Cached comparison bundled (${(affinityCache.bytes / 1000).toFixed(0)} kB). ` +
          (boltzConfigured()
            ? "NVIDIA_API_KEY is set, so live re-runs are available."
            : "No NVIDIA_API_KEY, so live re-runs are unavailable.")
        : "No cached comparison bundled.",
      fallback:
        "The cached comparison is served instantly; a failed live run falls back to it. " +
        "Nothing else in the app depends on this.",
      required: false,
    },
    {
      id: "viewer",
      label: "3D viewer (3Dmol.js, CDN)",
      purpose: "Draws the protein, the drug and the mutated residue in the right-hand panel.",
      status: "ok",
      detail: "Loaded in the browser from 3Dmol.org. This check is server-side and cannot see it.",
      fallback:
        "The viewer panel reports the failure; every number in the left-hand panel is " +
        "computed server-side and is unaffected.",
      required: false,
    },
  ];

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    overall: checks.some((c) => c.required && c.status !== "ok")
      ? "down"
      : checks.some((c) => c.status !== "ok")
        ? "degraded"
        : "ok",
    checks,
    targets: targetChecks,
  });
}
