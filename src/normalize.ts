import type { Expr, RelNode, SelectItem } from "./ast.js";

const COMMUTATIVE_OPS = new Set(["and", "or", "=", "!=", "<>", "+", "*"]);
const ASSOCIATIVE_OPS = new Set(["and", "or", "+", "*"]);

export function canonicalKey(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalKey).join(",") + "]";
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => JSON.stringify(k) + ":" + canonicalKey(v));
  return "{" + entries.join(",") + "}";
}

function flattenBinary(op: string, expr: Expr, out: Expr[]): void {
  if (expr.kind === "binary" && expr.op === op) {
    flattenBinary(op, expr.left, out);
    flattenBinary(op, expr.right, out);
  } else {
    out.push(expr);
  }
}

export function normalizeExpr(expr: Expr): Expr {
  switch (expr.kind) {
    case "column":
    case "star":
    case "literal":
      return expr;
    case "func":
      return {
        ...expr,
        name: expr.name.toLowerCase(),
        args: expr.args.map(normalizeExpr),
      };
    case "unary":
      return { ...expr, op: expr.op.toLowerCase(), operand: normalizeExpr(expr.operand) };
    case "binary": {
      const op = expr.op.toLowerCase();
      const left = normalizeExpr(expr.left);
      const right = normalizeExpr(expr.right);
      let operands: Expr[] = [left, right];
      if (ASSOCIATIVE_OPS.has(op)) {
        operands = [];
        flattenBinary(op, left, operands);
        flattenBinary(op, right, operands);
      }
      if (COMMUTATIVE_OPS.has(op)) {
        operands = [...operands].sort((a, b) => {
          const ka = canonicalKey(a);
          const kb = canonicalKey(b);
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
      }
      let result = operands[0];
      for (let i = 1; i < operands.length; i++) {
        result = { kind: "binary", op, left: result, right: operands[i] };
      }
      return result;
    }
    case "case":
      return {
        ...expr,
        operand: expr.operand && normalizeExpr(expr.operand),
        whens: expr.whens.map(({ when, then }) => ({
          when: normalizeExpr(when),
          then: normalizeExpr(then),
        })),
        else: expr.else && normalizeExpr(expr.else),
      };
    case "window":
      return {
        ...expr,
        name: expr.name.toLowerCase(),
        args: expr.args.map(normalizeExpr),
        partitionBy: expr.partitionBy
          ?.map(normalizeExpr)
          .sort((a, b) => {
            const ka = canonicalKey(a);
            const kb = canonicalKey(b);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          }),
        orderBy: expr.orderBy?.map((o) => ({ ...o, expr: normalizeExpr(o.expr) })),
      };
    case "subquery":
      return { ...expr, query: normalizeRel(expr.query) };
  }
}

function normalizeItem(item: SelectItem): SelectItem {
  return { ...item, expr: normalizeExpr(item.expr) };
}

function byCanonicalKey<T>(a: T, b: T): number {
  const ka = canonicalKey(a);
  const kb = canonicalKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function normalizeRel(node: RelNode): RelNode {
  switch (node.kind) {
    case "scan":
      return node;
    case "project":
      return {
        ...node,
        input: normalizeRel(node.input),
        items: node.items.map(normalizeItem),
      };
    case "filter":
      return {
        ...node,
        input: normalizeRel(node.input),
        predicate: normalizeExpr(node.predicate),
      };
    case "join": {
      let left = normalizeRel(node.left);
      let right = normalizeRel(node.right);
      if (
        (node.joinType === "inner" || node.joinType === "cross") &&
        byCanonicalKey(right, left) < 0
      ) {
        [left, right] = [right, left];
      }
      return { ...node, left, right, on: node.on && normalizeExpr(node.on) };
    }
    case "union": {
      const inputs = node.inputs.map(normalizeRel).sort(byCanonicalKey);
      return { ...node, inputs };
    }
    case "aggregate":
      return {
        ...node,
        input: normalizeRel(node.input),
        groupBy: node.groupBy.map(normalizeItem).sort(byCanonicalKey),
        aggregates: node.aggregates.map(normalizeItem),
      };
  }
}
