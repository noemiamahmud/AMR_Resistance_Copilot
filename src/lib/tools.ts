/**
 * Phase 4 - the structural computations, exposed as tools the model can call.
 *
 * These are not a second implementation. Each one is a thin wrapper over the same
 * functions the deterministic pipeline uses, measuring the same bundled structure, so the
 * agent and the pipeline cannot drift apart and quietly disagree.
 *
 * Every tool takes and returns *clinical* residue numbers - the numbering a surveillance
 * analyst actually has in hand - and converts to the structure's own numbering internally.
 * That conversion is the trap documented in lib/targets.ts, and it is exactly the kind of
 * thing that must not be left to a model.
 */

import type { ToolSpec } from "./ollama";
import { CatalogueEntry, loadAssets } from "./analysis";
import { THREE_TO_ONE } from "./aminoAcids";
import { parseMutation } from "./mutation";
import { confidenceAt, drugProximity, neighborsWithin } from "./structure";
import { TargetDefinition, clinicalToUniprot } from "./targets";

export interface ToolDefinition {
  spec: ToolSpec;
  run(args: Record<string, unknown>): unknown;
}

export interface Toolbox {
  specs: ToolSpec[];
  names: string[];
  execute(name: string, args: Record<string, unknown>): { ok: boolean; result: unknown };
}

class ToolArgumentError extends Error {}

/** Models pass "450", 450, or "rpoB S450P" for a residue; accept all three. */
function residueArg(args: Record<string, unknown>, key = "residue"): number {
  const raw = args[key] ?? args.residue ?? args.residue_number ?? args.position;
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  if (typeof raw === "string") {
    const digits = raw.match(/\d+/);
    if (digits) return Number(digits[0]);
  }
  throw new ToolArgumentError(`expected a residue number in "${key}"`);
}

function mutationArg(args: Record<string, unknown>): string {
  const raw = args.mutation ?? args.substitution ?? args.variant;
  if (typeof raw !== "string") throw new ToolArgumentError('expected a string "mutation"');
  return raw;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const raw = args[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return fallback;
}

function catalogueSummary(entry: CatalogueEntry) {
  return {
    mutation: entry.mutation,
    variantType: entry.variantType,
    evidence: entry.evidence,
    citation: entry.citation,
  };
}

export async function makeToolbox(target: TargetDefinition): Promise<Toolbox> {
  const assets = await loadAssets(target);
  const offset = target.clinicalToUniprotOffset;

  /** Resolve a clinical number onto the structure, or say why it cannot be resolved. */
  const resolve = (clinical: number) => {
    const uniprotResnum = clinicalToUniprot(target, clinical);
    const residue = assets.structure.residues.get(uniprotResnum);
    if (!residue) {
      throw new ToolArgumentError(
        `residue ${clinical} is outside ${target.gene} (1-${target.clinicalLength} in catalogue numbering)`,
      );
    }
    return { uniprotResnum, residue };
  };

  const definitions: ToolDefinition[] = [
    {
      spec: {
        type: "function",
        function: {
          name: "distance_to_drug",
          description:
            `Measure how close a residue sits to ${target.drug} in the drug-bound structure. ` +
            "Returns the minimum heavy-atom distance in angstroms, the same distance from the " +
            "alpha carbon, and whether the residue is one of the experimentally observed drug " +
            "contacts. Under about 5 A is direct contact; over about 12 A is remote.",
          parameters: {
            type: "object",
            properties: {
              residue: { type: "integer", description: "Residue number in catalogue numbering, e.g. 450." },
            },
            required: ["residue"],
          },
        },
      },
      run: (args) => {
        const clinical = residueArg(args);
        const { uniprotResnum } = resolve(clinical);
        const prox = drugProximity(
          assets.structure, uniprotResnum, assets.drugAtoms, assets.pocket.residues, offset,
        );
        return {
          residue: clinical,
          minDistanceToDrugAngstroms: prox.minDistanceToDrugAngstroms,
          alphaCarbonDistanceAngstroms: prox.caDistanceToDrugAngstroms,
          proximity: prox.proximity,
          isObservedDrugContact: prox.isPocketResidue,
          nearestDrugContactResidue: prox.nearestPocketResidue
            ? `${prox.nearestPocketResidue.aa}${prox.nearestPocketResidue.clinicalResnum} at ` +
              `${prox.nearestPocketResidue.distanceAngstroms} A`
            : null,
        };
      },
    },
    {
      spec: {
        type: "function",
        function: {
          name: "plddt_at",
          description:
            "AlphaFold pLDDT (0-100) at a residue: how much the local coordinates can be " +
            "trusted. Above 90 is very high, above 70 confident. It says nothing about " +
            "resistance - only about whether the other measurements are reliable here.",
          parameters: {
            type: "object",
            properties: {
              residue: { type: "integer", description: "Residue number in catalogue numbering." },
            },
            required: ["residue"],
          },
        },
      },
      run: (args) => {
        const clinical = residueArg(args);
        const { residue } = resolve(clinical);
        const conf = confidenceAt(residue);
        return { residue: clinical, plddt: conf.plddt, band: conf.band };
      },
    },
    {
      spec: {
        type: "function",
        function: {
          name: "burial_at",
          description:
            "How buried a residue is, as a neighbour count within 10 A expressed as a " +
            "percentile against every residue of this protein. 100 is the most buried " +
            "residue in the structure, 0 the most exposed. Buried positions tolerate " +
            "changes in side-chain size poorly.",
          parameters: {
            type: "object",
            properties: {
              residue: { type: "integer", description: "Residue number in catalogue numbering." },
            },
            required: ["residue"],
          },
        },
      },
      run: (args) => {
        const clinical = residueArg(args);
        const { uniprotResnum } = resolve(clinical);
        const burial = assets.burial(uniprotResnum);
        return {
          residue: clinical,
          neighboursWithin10Angstroms: burial.neighborCount,
          percentile: burial.percentile,
          band: burial.band,
        };
      },
    },
    {
      spec: {
        type: "function",
        function: {
          name: "neighbors_within",
          description:
            "List the residues packed around a residue in 3D, nearest first, with the " +
            "distance to each. Use it to see what the side chain is actually touching.",
          parameters: {
            type: "object",
            properties: {
              residue: { type: "integer", description: "Residue number in catalogue numbering." },
              radius: {
                type: "number",
                description: "Search radius in angstroms, 3 to 12. Defaults to 6.",
              },
            },
            required: ["residue"],
          },
        },
      },
      run: (args) => {
        const clinical = residueArg(args);
        const radius = Math.min(12, Math.max(3, numberArg(args, "radius", 6)));
        const { uniprotResnum } = resolve(clinical);
        const found = neighborsWithin(assets.structure, uniprotResnum, radius, offset);
        return {
          residue: clinical,
          radiusAngstroms: radius,
          count: found.length,
          // Cap the list: the model needs the shape of the environment, not a printout.
          neighbours: found.slice(0, 12).map((n) => ({
            residue: n.clinicalResnum,
            aa: THREE_TO_ONE[n.resName] ?? n.resName,
            distanceAngstroms: n.distanceAngstroms,
          })),
          truncated: found.length > 12,
        };
      },
    },
    {
      spec: {
        type: "function",
        function: {
          name: "catalogue_lookup",
          description:
            `Look a substitution up in ${assets.catalogue.catalogue}. Returns the entry if ` +
            "the mutation has been catalogued, and otherwise reports that there is no entry. " +
            "A catalogue is a list of what has already been seen: a miss is not evidence " +
            "that a mutation is harmless, only that nobody has recorded it.",
          parameters: {
            type: "object",
            properties: {
              mutation: {
                type: "string",
                description: 'A substitution such as "S450L" or "rpoB S450L".',
              },
            },
            required: ["mutation"],
          },
        },
      },
      run: (args) => {
        const parsed = parseMutation(mutationArg(args));
        const exact = assets.catalogue.entries.find((e) => e.mutation === parsed.canonical) ?? null;
        const sameResidue = assets.catalogue.entries.filter(
          (e) => e.clinicalResnum === parsed.clinicalResnum && e.mutation !== parsed.canonical,
        );
        return {
          mutation: parsed.canonical,
          catalogue: assets.catalogue.catalogue,
          known: exact !== null,
          entry: exact ? catalogueSummary(exact) : null,
          otherSubstitutionsAtThisResidue: sameResidue.map((e) => e.mutation),
          note: exact
            ? "This substitution is catalogued."
            : "No entry. The catalogue can say nothing further about this substitution.",
        };
      },
    },
  ];

  const byName = new Map(definitions.map((d) => [d.spec.function.name, d]));

  return {
    specs: definitions.map((d) => d.spec),
    names: [...byName.keys()],
    execute(name, args) {
      const tool = byName.get(name);
      if (!tool) {
        return {
          ok: false,
          result: { error: `no such tool "${name}"; available: ${[...byName.keys()].join(", ")}` },
        };
      }
      try {
        return { ok: true, result: tool.run(args) };
      } catch (err) {
        // Hand the failure back to the model as a tool result: a bad argument is
        // recoverable, and the trace should show the recovery.
        return { ok: false, result: { error: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
