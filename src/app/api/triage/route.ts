import { NextResponse } from "next/server";

import { AnalysisError, MutationParseError } from "@/lib/analysis";
import { triageBatch } from "@/lib/triage";

/**
 * Structure only, and therefore fast: the table can render before the model has been asked
 * anything. The browser then fills in the mechanism per row against /api/reason.
 */
export async function POST(request: Request) {
  let mutations: unknown;
  let target: string | null = null;
  try {
    const body = await request.json();
    mutations = body.mutations;
    target = typeof body.target === "string" ? body.target : null;
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (typeof mutations !== "string" && !Array.isArray(mutations)) {
    return NextResponse.json(
      { error: 'Expected "mutations" as a string or an array of strings.' },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(await triageBatch(mutations as string | string[], target));
  } catch (err) {
    if (err instanceof MutationParseError || err instanceof AnalysisError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("triage failed", err);
    return NextResponse.json({ error: "Triage failed unexpectedly." }, { status: 500 });
  }
}
