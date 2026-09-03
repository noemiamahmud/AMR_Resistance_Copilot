/** Loads the bundled assets and runs the Phase 1 structural analysis. */

import { promises as fs } from "fs";
import path from "path";

import { describeSubstitution, SubstitutionProperties, THREE_TO_ONE } from "./aminoAcids";
import { MutationParseError, ParsedMutation, parseMutation } from "./mutation";
import { Atom, ParsedStructure, parsePdb } from "./pdb";
import {
  BurialAtResidue, ConfidenceAtResidue, DrugProximity, PocketResidueRef,
  confidenceAt, drugProximity, makeBurialCalculator,
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
  /** Phase 3 fills this in; Phase 1 already reports the raw lookup. */
  catalogue: {
    name: string;
    known: boolean;
    exactMatch: CatalogueEntry | null;
    sameResidueEntries: CatalogueEntry[];
  };
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

  const exactMatch =
    assets.catalogue.entries.find((e) => e.mutation === parsed.canonical) ?? null;
  const sameResidueEntries = assets.catalogue.entries.filter(
    (e) => e.clinicalResnum === parsed.clinicalResnum && e.mutation !== parsed.canonical,
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
    catalogue: {
      name: assets.catalogue.catalogue,
      known: exactMatch !== null,
      exactMatch,
      sameResidueEntries,
    },
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
