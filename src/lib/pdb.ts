/** Minimal PDB ATOM/HETATM parser - enough for coordinates, B-factors and residues. */

export interface Atom {
  serial: number;
  name: string;
  resName: string;
  chain: string;
  resSeq: number;
  x: number;
  y: number;
  z: number;
  /** In AlphaFold models the B-factor column carries pLDDT, not a B-factor. */
  bFactor: number;
  element: string;
  isHetatm: boolean;
}

export interface Residue {
  resSeq: number;
  resName: string;
  chain: string;
  atoms: Atom[];
}

export interface ParsedStructure {
  atoms: Atom[];
  residues: Map<number, Residue>;
}

/**
 * PDB is a column-oriented format; we slice by column rather than splitting on
 * whitespace, because fields run together in wide structures.
 */
export function parsePdb(text: string): ParsedStructure {
  const atoms: Atom[] = [];
  for (const line of text.split("\n")) {
    const isAtom = line.startsWith("ATOM");
    const isHetatm = line.startsWith("HETATM");
    if (!isAtom && !isHetatm) continue;
    if (line.length < 54) continue;

    const altLoc = line[16];
    if (altLoc !== " " && altLoc !== "A" && altLoc !== "") continue;

    const x = Number(line.slice(30, 38));
    const y = Number(line.slice(38, 46));
    const z = Number(line.slice(46, 54));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;

    const element = (line.slice(76, 78).trim() || line.slice(12, 16).trim()[0] || "").toUpperCase();

    atoms.push({
      serial: Number(line.slice(6, 11)) || atoms.length + 1,
      name: line.slice(12, 16).trim(),
      resName: line.slice(17, 20).trim(),
      chain: line.slice(21, 22).trim() || "A",
      resSeq: Number(line.slice(22, 26)),
      x, y, z,
      bFactor: Number(line.slice(60, 66)) || 0,
      element,
      isHetatm,
    });
  }

  const residues = new Map<number, Residue>();
  for (const atom of atoms) {
    if (atom.isHetatm) continue;
    let residue = residues.get(atom.resSeq);
    if (!residue) {
      residue = { resSeq: atom.resSeq, resName: atom.resName, chain: atom.chain, atoms: [] };
      residues.set(atom.resSeq, residue);
    }
    residue.atoms.push(atom);
  }
  return { atoms, residues };
}

/** Heavy atoms only - hydrogens are absent from AlphaFold models anyway. */
export function heavyAtoms(atoms: Atom[]): Atom[] {
  return atoms.filter((a) => a.element !== "H");
}

export function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function minDistance(
  from: readonly { x: number; y: number; z: number }[],
  to: readonly { x: number; y: number; z: number }[],
): number {
  let best = Infinity;
  for (const a of from) {
    for (const b of to) {
      const d = distance(a, b);
      if (d < best) best = d;
    }
  }
  return best;
}

/** The representative side-chain atom: CB, or CA for glycine. */
export function sideChainCentre(residue: Residue): Atom | undefined {
  return (
    residue.atoms.find((a) => a.name === "CB") ??
    residue.atoms.find((a) => a.name === "CA")
  );
}

/**
 * One-letter sequence in residue-number order, for the residue range actually modelled.
 * Boltz needs a sequence rather than coordinates, and taking it from the same structure
 * the rest of the app measures keeps the numbering trap in one place.
 */
export function sequenceOf(
  structure: ParsedStructure,
  threeToOne: Record<string, string>,
): { sequence: string; firstResSeq: number; lastResSeq: number; gaps: number[] } {
  const numbers = [...structure.residues.keys()].sort((a, b) => a - b);
  if (numbers.length === 0) return { sequence: "", firstResSeq: 0, lastResSeq: 0, gaps: [] };

  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const gaps: number[] = [];
  let sequence = "";
  for (let i = first; i <= last; i++) {
    const residue = structure.residues.get(i);
    if (!residue) {
      gaps.push(i);
      continue;
    }
    sequence += threeToOne[residue.resName] ?? "X";
  }
  return { sequence, firstResSeq: first, lastResSeq: last, gaps };
}
