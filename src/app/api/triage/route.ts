import { NextResponse } from "next/server";

import { AnalysisError, MutationParseError } from "@/lib/analysis";
import { triageBatch } from "@/lib/triage";

/**
 * Structure only, and therefore fast: the table can render before the model has been asked
 * anything. The browser then fills in the mechanism per row against /api/reason.
 */
export async function POST(request: Request) {
  let mutations: unknown;
  try {
    ({ mutations } = await request.json());
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
    return NextResponse.json(await triageBatch(mutations as string | string[]));
  } catch (err) {
    if (err instanceof MutationParseError || err instanceof AnalysisError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("triage failed", err);
    return NextResponse.json({ error: "Triage failed unexpectedly." }, { status: 500 });
  }
}
