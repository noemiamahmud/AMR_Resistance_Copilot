import { NextResponse } from "next/server";

import { AnalysisError } from "@/lib/analysis";
import { affinityFor } from "@/lib/affinity";
import { MutationParseError } from "@/lib/mutation";

/**
 * Cached by default and therefore instant, which is the fence: a demo must never wait on a
 * rate-limited cloud service. `live` opts in to a real run, and a live run that fails or
 * times out still returns the cached comparison rather than an error.
 *
 * A live run is several minutes of GPU time on someone else's quota, so it only ever
 * happens on an explicit request - never on page load.
 */
export const maxDuration = 800;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mutation = url.searchParams.get("mutation");
  if (!mutation) {
    return NextResponse.json({ error: 'Expected a "mutation" query parameter.' }, { status: 400 });
  }
  const live = url.searchParams.get("live");
  const wantsLive = live !== null && live !== "0";

  try {
    return NextResponse.json(
      await affinityFor(mutation, {
        live: wantsLive,
        replicates: Number(url.searchParams.get("replicates")) || undefined,
        signal: request.signal,
      }),
    );
  } catch (err) {
    if (err instanceof MutationParseError || err instanceof AnalysisError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    console.error("affinity failed", err);
    return NextResponse.json({ error: "The affinity comparison failed." }, { status: 500 });
  }
}
