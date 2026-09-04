/**
 * Target registry, read from scripts/targets.json.
 *
 * The manifest is the single source of truth and both sides read it: the Python builder
 * that derives the pocket, ligand pose and catalogue for a target, and the app that serves
 * them. Keeping two lists in step by hand is exactly the kind of drift that ends with the
 * UI describing one structure while measuring another, so there is only one list.
 *
 * Adding a target is therefore a manifest edit plus `python3 scripts/build_target.py <id>`.
 * No application code changes.
 *
 * Numbering, carefully: resistance catalogues number each gene against a RefSeq protein
 * that need not match the UniProt entry the structures use. For rpoB the two differ by a
 * six-residue N-terminal extension, so clinical S450L is residue 456 in the structure. The
 * builder re-derives that offset from the catalogue rather than trusting the manifest, and
 * refuses to build if the two disagree.
 */

import manifest from "../../scripts/targets.json";

export interface TargetDefinition {
  id: string;
  gene: string;
  aliases: string[];
  organism: string;
  organismTaxonId: number;
  proteinName: string;
  drug: string;
  drugClass: string;
  uniprotAccession: string;
  /** Length of the UniProt / structure sequence. */
  uniprotLength: number;
  /** Reference the catalogues number against. */
  clinicalReference: string;
  clinicalLength: number;
  /** clinicalResnum + offset === uniprotResnum */
  clinicalToUniprotOffset: number;
  structureFile: string;
  structureSource: string;
  ligandPoseFile: string;
  ligandSource: string;
  /** The drug as a molecule, for the optional Boltz-2 co-fold. */
  ligandName: string;
  ligandSmiles: string;
  ligandCode: string;
  complexPdbId: string;
  pocketFile: string;
  catalogueFile: string;
  /** Only some targets have a hand-labelled eval set; the eval says so when they do not. */
  goldenSetFile: string | null;
  /** One sentence of orientation for a reader who does not already know the biology. */
  blurb: string;
  /** What to analyse when this target is chosen. */
  heroMutation: string;
  /**
   * The tour. Each example says what it is meant to demonstrate, so the buttons double as
   * an explanation of what the tool is for rather than being an unlabelled list of codes.
   */
  examples: { mutation: string; kind: "catalogued" | "novel" | "distal"; why: string }[];
  /**
   * Distant, conservative substitutions used to pad the batch-triage isolate. A real
   * variant call is mostly changes that do nothing, and a triage table showing only hits
   * would demonstrate nothing about ranking.
   */
  quietExamples: string[];
}

export const TARGETS: TargetDefinition[] = manifest.targets as TargetDefinition[];

/** The hero path, and what an empty target selection means. */
export const DEFAULT_TARGET: TargetDefinition = TARGETS[0];

/** Kept as a named export because the hero case is referenced by name in several places. */
export const RPOB_RIFAMPICIN = DEFAULT_TARGET;

export function findTarget(gene: string): TargetDefinition | undefined {
  const key = gene.trim().toLowerCase();
  return TARGETS.find((t) => t.gene.toLowerCase() === key || t.aliases.includes(key));
}

export function targetById(id: string | null | undefined): TargetDefinition | undefined {
  if (!id) return undefined;
  return TARGETS.find((t) => t.id === id);
}

/**
 * Which target a request is about. An explicit id wins; otherwise a gene typed into the
 * mutation box selects one, so "gyrA D94G" works without touching the picker; otherwise
 * the caller's current target, and finally the hero.
 */
export function resolveTarget(
  explicitId?: string | null,
  gene?: string | null,
): TargetDefinition | undefined {
  if (explicitId) {
    const byId = targetById(explicitId);
    if (!byId) return undefined;
    // A gene in the text overrides the picker, so pasting a mutation just works.
    return (gene && findTarget(gene)) || byId;
  }
  if (gene) return findTarget(gene);
  return DEFAULT_TARGET;
}

export function clinicalToUniprot(t: TargetDefinition, clinical: number): number {
  return clinical + t.clinicalToUniprotOffset;
}

export function uniprotToClinical(t: TargetDefinition, uniprot: number): number {
  return uniprot - t.clinicalToUniprotOffset;
}
