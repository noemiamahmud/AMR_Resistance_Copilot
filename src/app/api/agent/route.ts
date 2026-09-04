import { NextResponse } from "next/server";

import { AnalysisError, MutationParseError, runAgent } from "@/lib/agent";
import { OllamaUnavailableError } from "@/lib/reasoning";

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
    return NextResponse.json(await runAgent(mutation, { signal: request.signal, targetId: target }));
  } catch (err) {
    if (err instanceof MutationParseError || err instanceof AnalysisError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof OllamaUnavailableError) {
      return NextResponse.json({ error: err.message, unavailable: true }, { status: 503 });
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    console.error("agent run failed", err);
    return NextResponse.json({ error: "The agent run failed unexpectedly." }, { status: 500 });
  }
}
