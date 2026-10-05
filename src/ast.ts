import type { Rational } from "./rational.js";
import type { UnitDef } from "./units.js";

interface Span {
  /** 0-based character offset of the first character. */
  readonly start: number;
  /** 0-based character offset one past the last character. */
  readonly end: number;
}

export type Ast =
  | ({ kind: "num"; value: Rational } & Span)
  | ({ kind: "unit"; name: string; def: UnitDef } & Span)
  | ({ kind: "neg"; expr: Ast } & Span)
  | ({ kind: "pow"; base: Ast; exp: number } & Span)
  | ({ kind: "bin"; op: "+" | "-" | "*" | "/"; left: Ast; right: Ast } & Span);

export type AstKind = Ast["kind"];
