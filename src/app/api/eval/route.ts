import { NextResponse } from "next/server";

import { runEvaluation } from "@/lib/evaluation";

/**
 * Deterministic and model-free, so it returns in milliseconds and returns the same thing
 * every time. The model's own verdict on the golden set is filled in afterwards by the
 * browser, one mutation at a time against /api/reason - the catalogue-blind path, which is
 * the only path it is fair to score.
 */
export async function GET() {
  try {
    return NextResponse.json(await runEvaluation());
  } catch (err) {
    console.error("evaluation failed", err);
    return NextResponse.json(
      { error: "The evaluation could not be run against the bundled golden set." },
      { status: 500 },
    );
  }
}
