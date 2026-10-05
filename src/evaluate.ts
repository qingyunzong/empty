import type { Ast } from "./ast.js";
import {
  dimsAdd,
  dimsEqual,
  dimsIsZero,
  dimsScale,
  dimsSub,
  dimsToUnitString,
  dimsZero,
  type Dims,
} from "./dims.js";
import { CalcError, UnitError } from "./errors.js";
import { Rational } from "./rational.js";

/** A quantity: exact rational value in coherent SI base units + dimensions. */
export interface Quantity {
  readonly value: Rational;
  readonly dims: Dims;
}

export function quantityEqual(a: Quantity, b: Quantity): boolean {
  return a.value.equals(b.value) && dimsEqual(a.dims, b.dims);
}

export function formatQuantity(q: Quantity): string {
  return dimsIsZero(q.dims)
    ? q.value.toString()
    : `${q.value.toString()} ${dimsToUnitString(q.dims)}`;
}

function mismatch(
  op: "+" | "-",
  left: { start: number; end: number; q: Quantity },
  right: { start: number; end: number; q: Quantity },
  start: number,
  end: number,
): UnitError {
  return new UnitError(
    op,
    { start: left.start, end: left.end, unit: dimsToUnitString(left.q.dims) },
    { start: right.start, end: right.end, unit: dimsToUnitString(right.q.dims) },
    start,
    end,
  );
}

/** Direct recursive evaluation of a parsed expression. */
export function evaluate(node: Ast): Quantity {
  switch (node.kind) {
    case "num":
      return { value: node.value, dims: dimsZero() };
    case "unit":
      return { value: node.def.scale, dims: node.def.dims };
    case "neg": {
      const q = evaluate(node.expr);
      return { value: q.value.neg(), dims: q.dims };
    }
    case "pow": {
      const q = evaluate(node.base);
      if (q.value.isZero() && node.exp < 0) {
        throw new CalcError("zero raised to a negative power", node.start, node.end);
      }
      return { value: q.value.pow(node.exp), dims: dimsScale(q.dims, node.exp) };
    }
    case "bin": {
      const l = evaluate(node.left);
      const r = evaluate(node.right);
      switch (node.op) {
        case "*":
          return { value: l.value.mul(r.value), dims: dimsAdd(l.dims, r.dims) };
        case "/":
          if (r.value.isZero()) {
            throw new CalcError("division by zero", node.start, node.end);
          }
          return { value: l.value.div(r.value), dims: dimsSub(l.dims, r.dims) };
        case "+":
        case "-":
          // Zero values are NOT exempt: dimensions must match regardless.
          if (!dimsEqual(l.dims, r.dims)) {
            throw mismatch(
              node.op,
              { start: node.left.start, end: node.left.end, q: l },
              { start: node.right.start, end: node.right.end, q: r },
              node.start,
              node.end,
            );
          }
          return {
            value: node.op === "+" ? l.value.add(r.value) : l.value.sub(r.value),
            dims: l.dims,
          };
      }
    }
  }
}

/** AST annotated bottom-up with the quantity of every node. */
export interface TypedNode {
  readonly node: Ast;
  readonly quantity: Quantity;
  readonly children: readonly TypedNode[];
}

/** Evaluates while recording a typed tree for later cross-checking. */
export function evaluateTyped(node: Ast): TypedNode {
  switch (node.kind) {
    case "num":
    case "unit":
      return { node, quantity: evaluate(node), children: [] };
    case "neg": {
      const child = evaluateTyped(node.expr);
      return { node, quantity: evaluate(node), children: [child] };
    }
    case "pow": {
      const child = evaluateTyped(node.base);
      return { node, quantity: evaluate(node), children: [child] };
    }
    case "bin": {
      const left = evaluateTyped(node.left);
      const right = evaluateTyped(node.right);
      return { node, quantity: evaluate(node), children: [left, right] };
    }
  }
}

/**
 * Independent cross-check of a typed tree: recomputes every node's
 * quantity from its children alone (without calling `evaluate`), verifies
 * it against the stored annotation, and checks that child source ranges
 * nest inside their parent. Throws on any inconsistency.
 */
export function recheck(typed: TypedNode): Quantity {
  for (const child of typed.children) {
    if (child.node.start < typed.node.start || child.node.end > typed.node.end) {
      throw new Error(
        `cross-check failed: child range ${child.node.start}..${child.node.end} ` +
          `escapes parent range ${typed.node.start}..${typed.node.end}`,
      );
    }
  }
  const node = typed.node;
  let recomputed: Quantity;
  switch (node.kind) {
    case "num":
      recomputed = { value: node.value, dims: dimsZero() };
      break;
    case "unit":
      recomputed = { value: node.def.scale, dims: node.def.dims };
      break;
    case "neg": {
      const c = recheck(typed.children[0]!);
      recomputed = { value: c.value.neg(), dims: c.dims };
      break;
    }
    case "pow": {
      const c = recheck(typed.children[0]!);
      if (c.value.isZero() && node.exp < 0) {
        throw new CalcError("zero raised to a negative power", node.start, node.end);
      }
      recomputed = { value: c.value.pow(node.exp), dims: dimsScale(c.dims, node.exp) };
      break;
    }
    case "bin": {
      const l = recheck(typed.children[0]!);
      const r = recheck(typed.children[1]!);
      if (node.op === "*") {
        recomputed = { value: l.value.mul(r.value), dims: dimsAdd(l.dims, r.dims) };
      } else if (node.op === "/") {
        if (r.value.isZero()) {
          throw new CalcError("division by zero", node.start, node.end);
        }
        recomputed = { value: l.value.div(r.value), dims: dimsSub(l.dims, r.dims) };
      } else {
        if (!dimsEqual(l.dims, r.dims)) {
          throw mismatch(
            node.op,
            { start: node.left.start, end: node.left.end, q: l },
            { start: node.right.start, end: node.right.end, q: r },
            node.start,
            node.end,
          );
        }
        recomputed = {
          value: node.op === "+" ? l.value.add(r.value) : l.value.sub(r.value),
          dims: l.dims,
        };
      }
      break;
    }
  }
  if (!quantityEqual(recomputed, typed.quantity)) {
    throw new Error(
      `cross-check failed at ${node.start}..${node.end}: ` +
        `annotated ${formatQuantity(typed.quantity)} != recomputed ${formatQuantity(recomputed)}`,
    );
  }
  return recomputed;
}
