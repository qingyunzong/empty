import type { Ast } from "./ast.js";

/**
 * Canonical, fully parenthesized rendering of an AST. Reparsing the output
 * yields an equivalent expression; used by the cross-check tests.
 */
export function print(node: Ast): string {
  switch (node.kind) {
    case "num":
      return node.value.den === 1n ? node.value.toString() : `(${node.value.toString()})`;
    case "unit":
      return node.name;
    case "neg":
      return `(-${print(node.expr)})`;
    case "pow":
      return `(${print(node.base)})^${node.exp}`;
    case "bin":
      return `(${print(node.left)} ${node.op} ${print(node.right)})`;
  }
}
