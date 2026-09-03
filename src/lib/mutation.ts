/** Parses free-text mutation input such as "rpoB S450L" or "rpoB p.Ser450Leu". */

import { AMINO_ACIDS, THREE_TO_ONE } from "./aminoAcids";

export interface ParsedMutation {
  raw: string;
  gene: string | null;
  wildType: string;
  /** Residue number in the catalogue / clinical numbering the user typed. */
  clinicalResnum: number;
  mutant: string;
  /** Canonical one-letter form, e.g. "S450L". */
  canonical: string;
}

export class MutationParseError extends Error {}

const ONE = "ACDEFGHIKLMNPQRSTVWY";
const THREE = Object.keys(THREE_TO_ONE).join("|");

// S450L  |  Ser450Leu  |  p.Ser450Leu
const ONE_LETTER = new RegExp(`^([${ONE}])(\\d{1,5})([${ONE}])$`, "i");
const THREE_LETTER = new RegExp(`^(?:p\\.)?(${THREE})(\\d{1,5})(${THREE})$`, "i");

function normaliseResidue(token: string): { wt: string; num: number; mut: string } | null {
  const cleaned = token.replace(/\s+/g, "");
  const one = ONE_LETTER.exec(cleaned);
  if (one) {
    return { wt: one[1].toUpperCase(), num: Number(one[2]), mut: one[3].toUpperCase() };
  }
  const three = THREE_LETTER.exec(cleaned);
  if (three) {
    return {
      wt: THREE_TO_ONE[three[1].toUpperCase()],
      num: Number(three[2]),
      mut: THREE_TO_ONE[three[3].toUpperCase()],
    };
  }
  return null;
}

export function parseMutation(input: string): ParsedMutation {
  const raw = input.trim();
  if (!raw) throw new MutationParseError("Enter a gene and mutation, for example: rpoB S450L");

  // Split on whitespace, commas, colons; the mutation is whichever token parses.
  const tokens = raw.split(/[\s,:]+/).filter(Boolean);
  let gene: string | null = null;
  let hit: { wt: string; num: number; mut: string } | null = null;

  for (const token of tokens) {
    const parsed = normaliseResidue(token);
    if (parsed && !hit) hit = parsed;
    else if (!parsed && gene === null) gene = token;
  }

  if (!hit) {
    throw new MutationParseError(
      `Could not read a mutation from "${raw}". Use a form like "rpoB S450L" or "rpoB p.Ser450Leu".`,
    );
  }
  if (!AMINO_ACIDS[hit.wt] || !AMINO_ACIDS[hit.mut]) {
    throw new MutationParseError(`Unrecognised amino acid in "${raw}".`);
  }
  if (hit.num < 1) {
    throw new MutationParseError(`Residue number must be 1 or greater (got ${hit.num}).`);
  }
  if (hit.wt === hit.mut) {
    throw new MutationParseError(
      `"${hit.wt}${hit.num}${hit.mut}" is not a substitution - the two amino acids are the same.`,
    );
  }

  return {
    raw,
    gene,
    wildType: hit.wt,
    clinicalResnum: hit.num,
    mutant: hit.mut,
    canonical: `${hit.wt}${hit.num}${hit.mut}`,
  };
}
