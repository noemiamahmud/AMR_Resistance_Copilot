/** Loads the bundled assets and runs the Phase 1 structural analysis. */

import { promises as fs } from "fs";
import path from "path";

import { describeSubstitution, SubstitutionProperties, THREE_TO_ONE } from "./aminoAcids";
import { MutationParseError, ParsedMutation, parseMutation } from "./mutation";
import { Atom, ParsedStructure, parsePdb } from "./pdb";
import {
  BurialAtResidue, ConfidenceAtResidue, DrugProximity, PocketResidueRef,
  confidenceAt, drugProximity, makeBurialCalculator, neighborsWithin,
} from "./structure";
import { RPOB_RIFAMPICIN, TargetDefinition, clinicalToUniprot, findTarget } from "./targets";

export class AnalysisError extends Error {}

interface PocketFile {
  source: { pdbId: string; description: string; contactCutoffAngstroms: number; method: string };
  residueCount: number;
  residues: PocketResidueRef[];
}

export interface CatalogueEntry {
  mutation: string;
  wildType: string;
  clinicalResnum: number;
  mutant: string;
  aro: string;
  variantType: string;
  partOfCombination: string[] | null;
  evidence: string;
  citation: string;
}

interface CatalogueFile {
  catalogue: string;
  aro: string;
  entryCount: number;
  entries: CatalogueEntry[];
}

/** A catalogued resistance residue sitting near the query residue in 3D. */
export interface NearbyCatalogued {
  clinicalResnum: number;
  aa: string;
  distanceAngstroms: number;
  mutations: string[];
}

export interface CatalogueVerdict {
  name: string;
  aro: string;
  /** How many substitutions the catalogue holds for this gene, over how many residues. */
  entryCount: number;
  residuesCovered: number;
  known: boolean;
  exactMatch: CatalogueEntry | null;
  sameResidueEntries: CatalogueEntry[];
  /**
   * What a catalogue lookup on its own - today's standard practice - returns for this
   * mutation. When `call` is "no call" there is nothing further a catalogue can say.
   */
  catalogueOnly: { call: "resistance-associated" | "no call"; verdict: string };
  /**
   * Catalogued resistance residues within NEIGHBOURHOOD_ANGSTROMS of this one. Context for
   * the analyst, not evidence: this is catalogue knowledge and is deliberately kept out of
   * the payload the model reasons over (see lib/reasoning.ts).
   */
  nearbyKnownResistance: NearbyCatalogued[];
}

export interface AnalysisResult {
  input: ParsedMutation;
  target: {
    gene: string; organism: string; proteinName: string; drug: string;
    uniprotAccession: string; structureSource: string; ligandSource: string;
  };
  numbering: {
    clinicalResnum: number;
    uniprotResnum: number;
    offset: number;
    clinicalReference: string;
    uniprotReference: string;
    explanation: string;
  };
  /** Did the wild-type residue the user typed actually match the structure? */
  validation: {
    structureWildType: string;
    matchesInput: boolean;
    message: string | null;
  };
  substitution: SubstitutionProperties;
  structure: {
    drug: DrugProximity;
    confidence: ConfidenceAtResidue;
    burial: BurialAtResidue;
  };
  pocket: {
    pdbId: string;
    description: string;
    method: string;
    contactCutoffAngstroms: number;
    residueCount: number;
    /** Clinical numbering, for display and for highlighting in the viewer. */
    clinicalResnums: number[];
    uniprotResnums: number[];
  };
  catalogue: CatalogueVerdict;
  headline: string;
  provenance: string[];
}

let cache: {
  structure: ParsedStructure;
  drugAtoms: Atom[];
  pocket: PocketFile;
  catalogue: CatalogueFile;
  burial: (resSeq: number) => BurialAtResidue;
} | null = null;

async function loadAssets(target: TargetDefinition) {
  if (cache) return cache;
  const dir = path.join(process.cwd(), "public");
  const [pdbText, ligandText, pocketRaw, catalogueRaw] = await Promise.all([
    fs.readFile(path.join(dir, target.structureFile), "utf8"),
    fs.readFile(path.join(dir, target.ligandPoseFile), "utf8"),
    fs.readFile(path.join(dir, target.pocketFile), "utf8"),
    fs.readFile(path.join(dir, target.catalogueFile), "utf8"),
  ]);

  const structure = parsePdb(pdbText);
  const drugAtoms = parsePdb(ligandText).atoms.filter((a) => a.isHetatm);
  if (drugAtoms.length === 0) {
    throw new AnalysisError("the bundled ligand pose contains no atoms");
  }

  cache = {
    structure,
    drugAtoms,
    pocket: JSON.parse(pocketRaw) as PocketFile,
    catalogue: JSON.parse(catalogueRaw) as CatalogueFile,
    burial: makeBurialCalculator(structure),
  };
  return cache;
}

/** How far out to look for catalogued resistance residues around the query residue. */
const NEIGHBOURHOOD_ANGSTROMS = 8;

function formatCitation(citation: string): string {
  return /^\d+$/.test(citation) ? `PMID ${citation}` : citation;
}

/**
 * The whole point of the project sits in this function: what does a resistance catalogue,
 * used the way it is used today, actually return for this mutation? For anything it has
 * not already seen, the honest answer is nothing at all - and that is the gap the
 * structural analysis fills.
 */
function catalogueVerdict(
  file: CatalogueFile,
  parsed: ParsedMutation,
  structure: ParsedStructure,
  uniprotResnum: number,
  offset: number,
): CatalogueVerdict {
  const exactMatch = file.entries.find((e) => e.mutation === parsed.canonical) ?? null;
  const sameResidueEntries = file.entries.filter(
    (e) => e.clinicalResnum === parsed.clinicalResnum && e.mutation !== parsed.canonical,
  );

  const cataloguedResidues = new Set(file.entries.map((e) => e.clinicalResnum));
  const nearbyKnownResistance = neighborsWithin(
    structure, uniprotResnum, NEIGHBOURHOOD_ANGSTROMS, offset,
  )
    .filter((n) => cataloguedResidues.has(n.clinicalResnum))
    .slice(0, 6)
    .map((n) => ({
      clinicalResnum: n.clinicalResnum,
      aa: THREE_TO_ONE[n.resName] ?? "?",
      distanceAngstroms: n.distanceAngstroms,
      mutations: file.entries
        .filter((e) => e.clinicalResnum === n.clinicalResnum)
        .map((e) => e.mutation),
    }));

  return {
    name: file.catalogue,
    aro: file.aro,
    entryCount: file.entryCount,
    residuesCovered: cataloguedResidues.size,
    known: exactMatch !== null,
    exactMatch,
    sameResidueEntries,
    catalogueOnly: exactMatch
      ? {
          call: "resistance-associated",
          verdict:
            `${file.catalogue} lists ${exactMatch.mutation} as a ${exactMatch.variantType} ` +
            `(${exactMatch.evidence}, ${formatCitation(exactMatch.citation)}).`,
        }
      : {
          call: "no call",
          verdict: `${file.catalogue} has no entry for ${parsed.canonical}. A catalogue lookup ends here.`,
        },
    nearbyKnownResistance,
  };
}

function headlineFor(
  mutation: ParsedMutation, prox: DrugProximity,
  conf: ConfidenceAtResidue, burial: BurialAtResidue, drug: string,
): string {
  const where =
    prox.proximity === "drug-contacting"
      ? `makes direct contact with ${drug} (${prox.minDistanceToDrugAngstroms} Å)`
      : prox.proximity === "pocket-lining"
        ? `lines the ${drug} binding site (${prox.minDistanceToDrugAngstroms} Å)`
        : prox.proximity === "pocket-peripheral"
          ? `sits just outside the ${drug} pocket (${prox.minDistanceToDrugAngstroms} Å)`
          : `is remote from the ${drug} pocket (${prox.minDistanceToDrugAngstroms} Å)`;
  return `${mutation.canonical} ${where}, in a ${conf.band}-confidence region (pLDDT ${conf.plddt}), ${burial.band}.`;
}

export async function analyseMutation(input: string): Promise<AnalysisResult> {
  const parsed = parseMutation(input);           // throws MutationParseError
  const target = (parsed.gene ? findTarget(parsed.gene) : RPOB_RIFAMPICIN) ?? null;
  if (!target) {
    throw new AnalysisError(
      `No structural target is bundled for "${parsed.gene}". This build covers rpoB (M. tuberculosis) with rifampicin.`,
    );
  }

  const assets = await loadAssets(target);
  const uniprotResnum = clinicalToUniprot(target, parsed.clinicalResnum);

  const residue = assets.structure.residues.get(uniprotResnum);
  if (!residue) {
    throw new AnalysisError(
      `Residue ${parsed.clinicalResnum} is outside the modelled sequence. ` +
        `${target.gene} is ${target.clinicalLength} residues in catalogue numbering.`,
    );
  }

  const structureWildType = THREE_TO_ONE[residue.resName] ?? "?";
  const matchesInput = structureWildType === parsed.wildType;

  const prox = drugProximity(
    assets.structure, uniprotResnum, assets.drugAtoms,
    assets.pocket.residues, target.clinicalToUniprotOffset,
  );
  const confidence = confidenceAt(residue);
  const burial = assets.burial(uniprotResnum);
  const substitution = describeSubstitution(parsed.wildType, parsed.mutant);

  const catalogue = catalogueVerdict(
    assets.catalogue, parsed, assets.structure, uniprotResnum, target.clinicalToUniprotOffset,
  );

  return {
    input: parsed,
    target: {
      gene: target.gene, organism: target.organism, proteinName: target.proteinName,
      drug: target.drug, uniprotAccession: target.uniprotAccession,
      structureSource: target.structureSource, ligandSource: target.ligandSource,
    },
    numbering: {
      clinicalResnum: parsed.clinicalResnum,
      uniprotResnum,
      offset: target.clinicalToUniprotOffset,
      clinicalReference: target.clinicalReference,
      uniprotReference: target.uniprotAccession,
      explanation:
        `Catalogues number ${target.gene} against ${target.clinicalReference} ` +
        `(${target.clinicalLength} aa); the structure uses ${target.uniprotAccession} ` +
        `(${target.uniprotLength} aa), which carries a ${target.clinicalToUniprotOffset}-residue ` +
        `N-terminal extension. Clinical ${parsed.clinicalResnum} is structure residue ${uniprotResnum}.`,
    },
    validation: {
      structureWildType,
      matchesInput,
      message: matchesInput
        ? null
        : `You entered ${parsed.wildType}${parsed.clinicalResnum}, but residue ` +
          `${parsed.clinicalResnum} is ${structureWildType} in ${target.clinicalReference}. ` +
          `Results below are for the residue at that position.`,
    },
    substitution,
    structure: { drug: prox, confidence, burial },
    pocket: {
      pdbId: assets.pocket.source.pdbId,
      description: assets.pocket.source.description,
      method: assets.pocket.source.method,
      contactCutoffAngstroms: assets.pocket.source.contactCutoffAngstroms,
      residueCount: assets.pocket.residueCount,
      clinicalResnums: assets.pocket.residues.map((r) => r.clinicalResnum),
      uniprotResnums: assets.pocket.residues.map((r) => r.uniprotResnum),
    },
    catalogue,
    headline: headlineFor(parsed, prox, confidence, burial, target.drug),
    provenance: [
      `Structure: ${target.structureSource} (${target.uniprotAccession})`,
      `Drug pose: ${target.ligandSource}`,
      `Pocket: ${assets.pocket.residueCount} residues within ` +
        `${assets.pocket.source.contactCutoffAngstroms} Å of ${target.drug} in ${assets.pocket.source.pdbId}`,
      `Catalogue: ${assets.catalogue.catalogue}, ${assets.catalogue.entryCount} rpoB substitutions (${assets.catalogue.aro})`,
    ],
  };
}

export { MutationParseError };
