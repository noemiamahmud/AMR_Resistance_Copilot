/**
 * The structural computations. Everything here is measured from coordinates -
 * nothing is looked up from a table of known answers.
 */

import {
  Atom, ParsedStructure, Residue,
  distance, heavyAtoms, minDistance, sideChainCentre,
} from "./pdb";

export const BURIAL_RADIUS_ANGSTROMS = 10;
/** At or below this heavy-atom distance we call the residue drug-contacting. */
export const CONTACT_ANGSTROMS = 5;
/** Beyond contact but still lining the site. */
export const POCKET_ANGSTROMS = 8;

export type ConfidenceBand = "very high" | "confident" | "low" | "very low";
export type BurialBand = "buried" | "partially buried" | "exposed";
export type PocketProximity = "drug-contacting" | "pocket-lining" | "pocket-peripheral" | "distant";

export interface PocketResidueRef {
  uniprotResnum: number;
  clinicalResnum: number;
  aa: string;
  minDistanceToRifampicin: number;
}

export interface Point3D { x: number; y: number; z: number }

export interface DrugProximity {
  /** Minimum heavy-atom distance from the residue to any drug atom, in angstroms. */
  minDistanceToDrugAngstroms: number;
  /** Same measurement from the CA only - more comparable between residues. */
  caDistanceToDrugAngstroms: number;
  proximity: PocketProximity;
  isPocketResidue: boolean;
  nearestPocketResidue: { clinicalResnum: number; aa: string; distanceAngstroms: number } | null;
  minDistanceToPocketResidueAngstroms: number;
  /** CA coordinate of the mutated residue - the viewer anchors its label here. */
  residueCenter: Point3D;
}

export interface ConfidenceAtResidue {
  plddt: number;
  band: ConfidenceBand;
}

export interface BurialAtResidue {
  /** Neighbouring residues whose CB (CA for Gly) lies within BURIAL_RADIUS_ANGSTROMS. */
  neighborCount: number;
  /** Where that count sits in this structure's own distribution, 0-100. */
  percentile: number;
  band: BurialBand;
}

export function bandForPlddt(plddt: number): ConfidenceBand {
  if (plddt >= 90) return "very high";
  if (plddt >= 70) return "confident";
  if (plddt >= 50) return "low";
  return "very low";
}

function bandForBurial(percentile: number): BurialBand {
  if (percentile >= 66) return "buried";
  if (percentile >= 33) return "partially buried";
  return "exposed";
}

function proximityFor(minDist: number): PocketProximity {
  if (minDist <= CONTACT_ANGSTROMS) return "drug-contacting";
  if (minDist <= POCKET_ANGSTROMS) return "pocket-lining";
  if (minDist <= 12) return "pocket-peripheral";
  return "distant";
}

/**
 * pLDDT is stored per-atom in the B-factor column but is a per-residue quantity,
 * so every atom of a residue carries the same value; we average defensively.
 */
export function confidenceAt(residue: Residue): ConfidenceAtResidue {
  const values = residue.atoms.map((a) => a.bFactor);
  const plddt = values.reduce((s, v) => s + v, 0) / values.length;
  return { plddt: +plddt.toFixed(1), band: bandForPlddt(plddt) };
}

/**
 * Burial as a neighbour count. Cheap, deterministic, and adequate for saying
 * "this side chain is packed into the core" versus "it is on the surface".
 * We express it as a percentile within this structure so the number is
 * self-calibrating rather than resting on an absolute cut-off.
 */
export function burialAt(structure: ParsedStructure, resSeq: number): BurialAtResidue {
  const centres: { resSeq: number; atom: Atom }[] = [];
  for (const [seq, residue] of structure.residues) {
    const atom = sideChainCentre(residue);
    if (atom) centres.push({ resSeq: seq, atom });
  }

  const countFor = (target: number): number => {
    const self = centres.find((c) => c.resSeq === target);
    if (!self) return 0;
    let n = 0;
    for (const other of centres) {
      if (other.resSeq === target) continue;
      if (distance(self.atom, other.atom) <= BURIAL_RADIUS_ANGSTROMS) n++;
    }
    return n;
  };

  const neighborCount = countFor(resSeq);
  const allCounts = centres.map((c) => countFor(c.resSeq)).sort((a, b) => a - b);
  const below = allCounts.filter((c) => c < neighborCount).length;
  const percentile = Math.round((below / allCounts.length) * 100);

  return { neighborCount, percentile, band: bandForBurial(percentile) };
}

/** Same as burialAt but reuses one precomputed neighbour distribution. */
export function makeBurialCalculator(structure: ParsedStructure) {
  const centres: { resSeq: number; atom: Atom }[] = [];
  for (const [seq, residue] of structure.residues) {
    const atom = sideChainCentre(residue);
    if (atom) centres.push({ resSeq: seq, atom });
  }
  const counts = new Map<number, number>();
  for (const a of centres) {
    let n = 0;
    for (const b of centres) {
      if (a.resSeq === b.resSeq) continue;
      if (distance(a.atom, b.atom) <= BURIAL_RADIUS_ANGSTROMS) n++;
    }
    counts.set(a.resSeq, n);
  }
  const sorted = [...counts.values()].sort((x, y) => x - y);

  return (resSeq: number): BurialAtResidue => {
    const neighborCount = counts.get(resSeq) ?? 0;
    const below = sorted.filter((c) => c < neighborCount).length;
    const percentile = Math.round((below / sorted.length) * 100);
    return { neighborCount, percentile, band: bandForBurial(percentile) };
  };
}

export function drugProximity(
  structure: ParsedStructure,
  uniprotResnum: number,
  drugAtoms: readonly Atom[],
  pocketResidues: readonly PocketResidueRef[],
  clinicalToUniprotOffset: number,
): DrugProximity {
  const residue = structure.residues.get(uniprotResnum);
  if (!residue) throw new Error(`residue ${uniprotResnum} is not present in the structure`);

  const residueHeavy = heavyAtoms(residue.atoms);
  const drugHeavy = heavyAtoms([...drugAtoms]);
  const minDist = minDistance(residueHeavy, drugHeavy);

  const ca = residue.atoms.find((a) => a.name === "CA");
  const caDist = ca ? minDistance([ca], drugHeavy) : minDist;

  // Nearest curated pocket residue, measured in the structure.
  let nearest: DrugProximity["nearestPocketResidue"] = null;
  let nearestDist = Infinity;
  for (const p of pocketResidues) {
    if (p.uniprotResnum === uniprotResnum) continue;
    const other = structure.residues.get(p.uniprotResnum);
    if (!other) continue;
    const d = minDistance(residueHeavy, heavyAtoms(other.atoms));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = { clinicalResnum: p.clinicalResnum, aa: p.aa, distanceAngstroms: +d.toFixed(2) };
    }
  }

  return {
    minDistanceToDrugAngstroms: +minDist.toFixed(2),
    caDistanceToDrugAngstroms: +caDist.toFixed(2),
    proximity: proximityFor(minDist),
    isPocketResidue: pocketResidues.some((p) => p.uniprotResnum === uniprotResnum),
    nearestPocketResidue: nearest,
    minDistanceToPocketResidueAngstroms: Number.isFinite(nearestDist) ? +nearestDist.toFixed(2) : Infinity,
    residueCenter: ca
      ? { x: ca.x, y: ca.y, z: ca.z }
      : { x: residueHeavy[0].x, y: residueHeavy[0].y, z: residueHeavy[0].z },
  };
}

/** Residues with any heavy atom within `radius` of the query residue. */
export function neighborsWithin(
  structure: ParsedStructure,
  uniprotResnum: number,
  radius: number,
  offset: number,
): { clinicalResnum: number; resName: string; distanceAngstroms: number }[] {
  const residue = structure.residues.get(uniprotResnum);
  if (!residue) throw new Error(`residue ${uniprotResnum} is not present in the structure`);
  const from = heavyAtoms(residue.atoms);

  const out: { clinicalResnum: number; resName: string; distanceAngstroms: number }[] = [];
  for (const [seq, other] of structure.residues) {
    if (seq === uniprotResnum) continue;
    const d = minDistance(from, heavyAtoms(other.atoms));
    if (d <= radius) {
      out.push({ clinicalResnum: seq - offset, resName: other.resName, distanceAngstroms: +d.toFixed(2) });
    }
  }
  return out.sort((a, b) => a.distanceAngstroms - b.distanceAngstroms);
}
