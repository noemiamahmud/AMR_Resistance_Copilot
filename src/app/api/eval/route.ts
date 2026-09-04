import { NextResponse } from "next/server";

import { runEvaluation } from "@/lib/evaluation";
import { DEFAULT_TARGET, targetById } from "@/lib/targets";

/**
 * Deterministic and model-free, so it returns in milliseconds and returns the same thing
 * every time. The model's own verdict on the golden set is filled in afterwards by the
 * browser, one mutation at a time against /api/reason - the catalogue-blind path, which is
 * the only path it is fair to score.
 */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("target");
  const target = targetById(id) ?? DEFAULT_TARGET;
  try {
    return NextResponse.json(await runEvaluation(target));
  } catch (err) {
    console.error("evaluation failed", err);
    return NextResponse.json(
      { error: "The evaluation could not be run against the bundled golden set." },
      { status: 500 },
    );
  }
}
