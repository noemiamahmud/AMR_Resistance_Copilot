import { NextResponse } from "next/server";

import { AnalysisError, MutationParseError, analyseMutation } from "@/lib/analysis";

export async function POST(request: Request) {
  let mutation: unknown;
  try {
    ({ mutation } = await request.json());
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (typeof mutation !== "string") {
    return NextResponse.json({ error: 'Expected a string field "mutation".' }, { status: 400 });
  }

  try {
    return NextResponse.json(await analyseMutation(mutation));
  } catch (err) {
    if (err instanceof MutationParseError || err instanceof AnalysisError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("analysis failed", err);
    return NextResponse.json({ error: "Analysis failed unexpectedly." }, { status: 500 });
  }
}
