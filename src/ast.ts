/** AST nodes. Every node carries a half-open source range [start, end). */
export type Node =
  | { kind: "num"; raw: string; start: number; end: number }
  | { kind: "unit"; name: string; start: number; end: number }
  | { kind: "neg"; operand: Node; start: number; end: number }
  | { kind: "bin"; op: "+" | "-" | "*" | "/"; left: Node; right: Node; start: number; end: number }
  | { kind: "pow"; base: Node; exponent: Node; start: number; end: number };
