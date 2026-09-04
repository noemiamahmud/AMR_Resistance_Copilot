import { NextResponse } from "next/server";

import { targetsWithGoldenSet } from "@/lib/evaluation";
import { TARGETS } from "@/lib/targets";

/**
 * What this build actually covers. The UI reads this rather than hard-coding a list, so
 * adding a target to scripts/targets.json is genuinely all it takes to make it selectable.
 */
export async function GET() {
  const evaluable = new Set(targetsWithGoldenSet().map((t) => t.id));
  return NextResponse.json({
    targets: TARGETS.map((t) => ({
      id: t.id,
      gene: t.gene,
      drug: t.drug,
      drugClass: t.drugClass,
      organism: t.organism,
      proteinName: t.proteinName,
      blurb: t.blurb,
      uniprotAccession: t.uniprotAccession,
      complexPdbId: t.complexPdbId,
      ligandCode: t.ligandCode,
      structureFile: t.structureFile,
      ligandPoseFile: t.ligandPoseFile,
      clinicalReference: t.clinicalReference,
      clinicalToUniprotOffset: t.clinicalToUniprotOffset,
      clinicalLength: t.clinicalLength,
      hasGoldenSet: evaluable.has(t.id),
    })),
  });
}
