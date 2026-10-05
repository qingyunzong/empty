/** Core term / atom / rule model for the stratified Datalog engine. */

export type Const = string | number;

export type Term =
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "const"; readonly value: Const };

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
  readonly body: readonly Literal[];
  /** Positive body literals, evaluated first during joins. */
  readonly posBody: readonly Literal[];
  /** Negative body literals, checked after all variables are bound. */
  readonly negBody: readonly Literal[];
  /** Original source text, used in provenance output. */
  readonly text: string;
}

export const variable = (name: string): Term => ({ kind: "var", name });
export const constant = (value: Const): Term => ({ kind: "const", value });

export const isVariable = (name: string): boolean => /^[A-Z_]/.test(name);

/** Canonical key for a ground atom, e.g. `edge("a","b")`. */
export function atomKey(pred: string, args: readonly Const[]): string {
  return `${pred}(${args.map((a) => JSON.stringify(a)).join(",")})`;
}

/** Predicate name portion of a key produced by {@link atomKey}. */
export function predOfKey(key: string): string {
  return key.slice(0, key.indexOf("("));
}

export type Substitution = Map<string, Const>;

/** Canonical key for one derivation (rule instantiation) of a fact. */
export function derivationKey(
  ruleId: number,
  headKey: string,
  pos: readonly string[],
  neg: readonly string[],
): string {
  const negPart = [...neg].sort().join(",");
  return `r${ruleId}|${headKey}|${pos.join(",")}|~${negPart}`;
}

export interface Derivation {
  readonly key: string;
  readonly ruleId: number;
  readonly ruleText: string;
  readonly head: string;
  /** Ground facts used positively, in body order. */
  readonly pos: readonly string[];
  /** Ground atoms whose absence was required. */
  readonly neg: readonly string[];
}

export function formatTerm(t: Term): string {
  return t.kind === "var" ? t.name : JSON.stringify(t.value);
}

export function formatAtom(a: Atom): string {
  return `${a.pred}(${a.args.map(formatTerm).join(", ")})`;
}

export function formatRule(r: Rule): string {
  if (r.body.length === 0) return `${formatAtom(r.head)}.`;
  const body = r.body
    .map((l) => (l.negated ? `not ${formatAtom(l.atom)}` : formatAtom(l.atom)))
    .join(", ");
  return `${formatAtom(r.head)} :- ${body}.`;
}
