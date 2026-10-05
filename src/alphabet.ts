/**
 * Symbolic segment alphabet.
 *
 * When both allow patterns consume a segment via wildcards, the emitted
 * segment only needs to be pinned down relative to the literals that any
 * pattern (allows and excludes) mentions: every string that is not one of
 * those literals behaves identically with respect to all patterns. We
 * therefore search over Literals ∪ {τ}, where τ is a symbolic "any other
 * segment" that concretizes to the byte-smallest non-literal string.
 */

export type Sym = { kind: "lit"; value: string } | { kind: "tau" };

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Byte-order comparison for plain lowercase strings. */
export function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Smallest non-empty [a-z]+ string (ordered by length, then bytes) that is
 * not contained in `literals`.
 */
export function smallestNonLiteral(literals: ReadonlySet<string>): string {
  let length = 1;
  for (;;) {
    const indices = new Array<number>(length).fill(0);
    for (;;) {
      const candidate = indices.map((k) => LETTERS[k]).join("");
      if (!literals.has(candidate)) return candidate;
      let pos = length - 1;
      while (pos >= 0 && indices[pos] === LETTERS.length - 1) pos--;
      if (pos < 0) break;
      indices[pos]!++;
      for (let q = pos + 1; q < length; q++) indices[q] = 0;
    }
    length++;
  }
}

export class SymbolTable {
  readonly literals: string[];
  readonly tauConcrete: string;
  /** Branching alphabet ordered by concretized byte value. */
  readonly ordered: Sym[];

  constructor(literals: Iterable<string>) {
    this.literals = [...new Set(literals)].sort(compareBytes);
    this.tauConcrete = smallestNonLiteral(new Set(this.literals));
    const entries: Array<{ sym: Sym; key: string }> = [
      ...this.literals.map((value) => ({
        sym: { kind: "lit", value } as Sym,
        key: value,
      })),
      { sym: { kind: "tau" }, key: this.tauConcrete },
    ];
    entries.sort((x, y) => compareBytes(x.key, y.key));
    this.ordered = entries.map((entry) => entry.sym);
  }

  /** Byte key used to order symbolic segments. */
  keyOf(sym: Sym): string {
    return sym.kind === "lit" ? sym.value : this.tauConcrete;
  }

  /** Concrete segment string for a symbolic segment. */
  concretize(sym: Sym): string {
    return sym.kind === "lit" ? sym.value : this.tauConcrete;
  }
}

/**
 * Compare two symbolic paths segment-by-segment using byte order of the
 * concretized segments; a strict prefix sorts first.
 */
export function compareSymPaths(table: SymbolTable, a: Sym[], b: Sym[]): number {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const cmp = compareBytes(table.keyOf(a[k]!), table.keyOf(b[k]!));
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}
