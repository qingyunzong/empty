/** A constant in the finite domain: a symbol, string or number. */
export type Const = string | number;

export interface VarTerm {
  readonly kind: "var";
  readonly name: string;
}

export interface ConstTerm {
  readonly kind: "const";
  readonly value: Const;
}

export type Term = VarTerm | ConstTerm;

export interface Atom {
  readonly pred: string;
  readonly args: readonly Term[];
}

export interface Literal {
  readonly atom: Atom;
  readonly negated: boolean;
}

export interface Rule {
  readonly id: number;
  readonly head: Atom;
  /** Body after normalization: positive literals first, then negated ones. */
  readonly body: readonly Literal[];
  /** Original source text, kept for provenance display. */
  readonly text: string;
}

/** A ground fact stored in the database. */
export interface Fact {
  readonly pred: string;
  readonly args: readonly Const[];
}

/** One way a derived fact can be justified. */
export interface Derivation {
  readonly ruleId: number;
  /** Ground facts that must be present (positive body literals). */
  readonly positive: readonly string[];
  /** Ground facts that must be absent (negated body literals). */
  readonly negative: readonly string[];
}

export function isVar(t: Term): t is VarTerm {
  return t.kind === "var";
}

/** Canonical string key for a ground atom, e.g. `edge(a,b)`. */
export function factKey(pred: string, args: readonly Const[]): string {
  const rendered = args
    .map((a) => (typeof a === "number" ? String(a) : a))
    .join(",");
  return `${pred}(${rendered})`;
}

export function keyOfFact(f: Fact): string {
  return factKey(f.pred, f.args);
}

export function parseFactKey(key: string): Fact {
  const open = key.indexOf("(");
  const pred = key.slice(0, open);
  const inner = key.slice(open + 1, -1);
  const args = inner.length === 0 ? [] : inner.split(",");
  return { pred, args };
}
