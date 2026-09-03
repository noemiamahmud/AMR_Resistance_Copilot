/** Amino-acid reference data used to describe the nature of a substitution. */

export const THREE_TO_ONE: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E",
  GLY: "G", HIS: "H", ILE: "I", LEU: "L", LYS: "K", MET: "M", PHE: "F",
  PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
};

export type AminoAcidClass =
  | "hydrophobic" | "polar" | "positive" | "negative" | "special";

export interface AminoAcid {
  code: string;
  name: string;
  /** Kyte-Doolittle hydropathy; positive is hydrophobic. */
  hydropathy: number;
  /** Side-chain volume in Å³ (Zamyatnin). */
  volume: number;
  charge: -1 | 0 | 1;
  klass: AminoAcidClass;
}

export const AMINO_ACIDS: Record<string, AminoAcid> = {
  A: { code: "A", name: "alanine",       hydropathy:  1.8, volume:  88.6, charge:  0, klass: "hydrophobic" },
  R: { code: "R", name: "arginine",      hydropathy: -4.5, volume: 173.4, charge:  1, klass: "positive"    },
  N: { code: "N", name: "asparagine",    hydropathy: -3.5, volume: 114.1, charge:  0, klass: "polar"       },
  D: { code: "D", name: "aspartate",     hydropathy: -3.5, volume: 111.1, charge: -1, klass: "negative"    },
  C: { code: "C", name: "cysteine",      hydropathy:  2.5, volume: 108.5, charge:  0, klass: "special"     },
  Q: { code: "Q", name: "glutamine",     hydropathy: -3.5, volume: 143.8, charge:  0, klass: "polar"       },
  E: { code: "E", name: "glutamate",     hydropathy: -3.5, volume: 138.4, charge: -1, klass: "negative"    },
  G: { code: "G", name: "glycine",       hydropathy: -0.4, volume:  60.1, charge:  0, klass: "special"     },
  H: { code: "H", name: "histidine",     hydropathy: -3.2, volume: 153.2, charge:  0, klass: "positive"    },
  I: { code: "I", name: "isoleucine",    hydropathy:  4.5, volume: 166.7, charge:  0, klass: "hydrophobic" },
  L: { code: "L", name: "leucine",       hydropathy:  3.8, volume: 166.7, charge:  0, klass: "hydrophobic" },
  K: { code: "K", name: "lysine",        hydropathy: -3.9, volume: 168.6, charge:  1, klass: "positive"    },
  M: { code: "M", name: "methionine",    hydropathy:  1.9, volume: 162.9, charge:  0, klass: "hydrophobic" },
  F: { code: "F", name: "phenylalanine", hydropathy:  2.8, volume: 189.9, charge:  0, klass: "hydrophobic" },
  P: { code: "P", name: "proline",       hydropathy: -1.6, volume: 112.7, charge:  0, klass: "special"     },
  S: { code: "S", name: "serine",        hydropathy: -0.8, volume:  89.0, charge:  0, klass: "polar"       },
  T: { code: "T", name: "threonine",     hydropathy: -0.7, volume: 116.1, charge:  0, klass: "polar"       },
  W: { code: "W", name: "tryptophan",    hydropathy: -0.9, volume: 227.8, charge:  0, klass: "hydrophobic" },
  Y: { code: "Y", name: "tyrosine",      hydropathy: -1.3, volume: 193.6, charge:  0, klass: "polar"       },
  V: { code: "V", name: "valine",        hydropathy:  4.2, volume: 140.0, charge:  0, klass: "hydrophobic" },
};

export interface SubstitutionProperties {
  wildType: AminoAcid;
  mutant: AminoAcid;
  hydropathyShift: number;
  volumeShiftCubicAngstroms: number;
  chargeShift: number;
  /** Short human-readable summary, e.g. "polar -> hydrophobic, +78 Å³, charge unchanged". */
  summary: string;
}

export function describeSubstitution(wt: string, mut: string): SubstitutionProperties {
  const wildType = AMINO_ACIDS[wt];
  const mutant = AMINO_ACIDS[mut];
  if (!wildType || !mutant) {
    throw new Error(`unknown amino acid in substitution ${wt}->${mut}`);
  }
  const volumeShift = +(mutant.volume - wildType.volume).toFixed(1);
  const chargeShift = mutant.charge - wildType.charge;
  const parts = [
    wildType.klass === mutant.klass
      ? `${wildType.klass} -> ${mutant.klass} (class unchanged)`
      : `${wildType.klass} -> ${mutant.klass}`,
    `${volumeShift >= 0 ? "+" : ""}${volumeShift} Å³ side-chain volume`,
    chargeShift === 0
      ? "charge unchanged"
      : `charge ${chargeShift > 0 ? "+" : ""}${chargeShift}`,
  ];
  return {
    wildType,
    mutant,
    hydropathyShift: +(mutant.hydropathy - wildType.hydropathy).toFixed(1),
    volumeShiftCubicAngstroms: volumeShift,
    chargeShift,
    summary: parts.join(", "),
  };
}
