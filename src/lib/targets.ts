/**
 * Target registry.
 *
 * Numbering, carefully:  the resistance catalogues (CARD, WHO) number M. tuberculosis
 * rpoB against NP_215181.1, which is 1172 aa.  UniProt P9WGY9 - and therefore the
 * AlphaFold model AF-P9WGY9-F1 and the deposited structure 5UHC - use a 1178 aa
 * sequence carrying a six-residue N-terminal extension (MLEGCI).  So the canonical
 * clinical mutation S450L lands on residue 456 of the structure.  Aligning the two
 * sequences at an offset of +6 gives zero mismatches across all 1171 shared residues.
 */

export interface TargetDefinition {
  id: string;
  gene: string;
  aliases: string[];
  organism: string;
  organismTaxonId: number;
  proteinName: string;
  drug: string;
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
  pocketFile: string;
  catalogueFile: string;
}

export const RPOB_RIFAMPICIN: TargetDefinition = {
  id: "rpoB-rifampicin",
  gene: "rpoB",
  aliases: ["rpob", "rv0667"],
  organism: "Mycobacterium tuberculosis H37Rv",
  organismTaxonId: 83332,
  proteinName: "DNA-directed RNA polymerase subunit beta",
  drug: "rifampicin",
  uniprotAccession: "P9WGY9",
  uniprotLength: 1178,
  clinicalReference: "NP_215181.1",
  clinicalLength: 1172,
  clinicalToUniprotOffset: 6,
  structureFile: "hero.pdb",
  structureSource: "AlphaFold DB AF-P9WGY9-F1-model_v6",
  ligandPoseFile: "data/rifampicin-pose.pdb",
  ligandSource: "PDB 5UHC ligand RFP, superposed onto the AlphaFold model (0.79 Å RMSD over 575 Cα atoms)",
  pocketFile: "data/pocket-rpob-rifampicin.json",
  catalogueFile: "data/card-rpob-rifampicin.json",
};

export const TARGETS: TargetDefinition[] = [RPOB_RIFAMPICIN];

export function findTarget(gene: string): TargetDefinition | undefined {
  const key = gene.trim().toLowerCase();
  return TARGETS.find((t) => t.gene.toLowerCase() === key || t.aliases.includes(key));
}

export function clinicalToUniprot(t: TargetDefinition, clinical: number): number {
  return clinical + t.clinicalToUniprotOffset;
}

export function uniprotToClinical(t: TargetDefinition, uniprot: number): number {
  return uniprot - t.clinicalToUniprotOffset;
}
