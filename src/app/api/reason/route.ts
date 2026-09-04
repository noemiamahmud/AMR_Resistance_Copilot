import { NextResponse } from "next/server";

import { AnalysisError, MutationParseError, analyseMutation } from "@/lib/analysis";
import { health, prewarm } from "@/lib/ollama";
import { OllamaUnavailableError, reasonAboutMutation } from "@/lib/reasoning";

/** Health, and optionally a warm-up call so the first real question is not a cold load. */
export async function GET(request: Request) {
  const status = await health();
  const wants = new URL(request.url).searchParams.get("prewarm");
  if (wants !== null && wants !== "0" && status.available && status.modelPresent) {
    return NextResponse.json({ ...status, prewarm: await prewarm() });
  }
  return NextResponse.json(status);
}

export async function POST(request: Request) {
  let mutation: unknown;
  let target: string | null = null;
  try {
    const body = await request.json();
    mutation = body.mutation;
    target = typeof body.target === "string" ? body.target : null;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (typeof mutation !== "string") {
    return NextResponse.json({ error: 'Expected a string field "mutation".' }, { status: 400 });
  }

  try {
    const analysis = await analyseMutation(mutation, target);
    // The browser aborts this request when the analyst asks about a different mutation.
    const reasoning = await reasonAboutMutation(analysis, { signal: request.signal });
    return NextResponse.json({ mutation: analysis.input.canonical, reasoning });
  } catch (err) {
    if (err instanceof MutationParseError || err instanceof AnalysisError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof OllamaUnavailableError) {
      // 503: the structural analysis stands on its own, only the reasoning is missing.
      return NextResponse.json({ error: err.message, unavailable: true }, { status: 503 });
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    console.error("reasoning failed", err);
    return NextResponse.json({ error: "Reasoning failed unexpectedly." }, { status: 500 });
  }
}
