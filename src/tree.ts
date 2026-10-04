import { Node } from "./ast";
import { Rational } from "./rational";
import {
  Dims, DIMENSIONLESS, dimsAdd, dimsSub, dimsScale, dimsEqual, canonicalUnit,
} from "./dims";
import { lookupUnit } from "./units";
import { Quantity } from "./eval";

/**
 * Compact serializable syntax tree ("small tree") used for cross-checking.
 * Plain JSON-able arrays: [tag, ...args]. No source ranges — this is the
 * minimal semantic tree.
 */
export type STree =
  | ["num", string]
  | ["unit", string]
  | ["neg", STree]
  | ["bin", "+" | "-" | "*" | "/", STree, STree]
  | ["pow", STree, STree];

export function toSTree(node: Node): STree {
  switch (node.kind) {
    case "num": return ["num", node.raw];
    case "unit": return ["unit", node.name];
    case "neg": return ["neg", toSTree(node.operand)];
    case "bin": return ["bin", node.op, toSTree(node.left), toSTree(node.right)];
    case "pow": return ["pow", toSTree(node.base), toSTree(node.exponent)];
  }
}

/** Render the small tree as an S-expression for inspection/tests. */
export function sexpr(t: STree): string {
  switch (t[0]) {
    case "num": return t[1];
    case "unit": return t[1];
    case "neg": return `(- ${sexpr(t[1])})`;
    case "bin": return `(${t[1]} ${sexpr(t[2])} ${sexpr(t[3])})`;
    case "pow": return `(^ ${sexpr(t[1])} ${sexpr(t[2])})`;
  }
}

/**
 * Independent re-evaluator that walks the serialized small tree (not the AST).
 * Used to cross-check the main evaluator: both must agree exactly.
 */
export function evalSTree(t: STree): Quantity {
  switch (t[0]) {
    case "num":
      return { value: Rational.parse(t[1]), dims: DIMENSIONLESS };
    case "unit": {
      const def = lookupUnit(t[1]);
      if (!def) throw new Error(`stree: unknown unit '${t[1]}'`);
      return { value: def.factor, dims: def.dims };
    }
    case "neg": {
      const q = evalSTree(t[1]);
      return { value: q.value.neg(), dims: q.dims };
    }
    case "bin": {
      const l = evalSTree(t[2]);
      const r = evalSTree(t[3]);
      const op = t[1];
      if (op === "*") return { value: l.value.mul(r.value), dims: dimsAdd(l.dims, r.dims) };
      if (op === "/") return { value: l.value.div(r.value), dims: dimsSub(l.dims, r.dims) };
      if (!dimsEqual(l.dims, r.dims)) {
        throw new Error(
          `stree: dimension mismatch '${canonicalUnit(l.dims)}' vs '${canonicalUnit(r.dims)}'`,
        );
      }
      return {
        value: op === "+" ? l.value.add(r.value) : l.value.sub(r.value),
        dims: l.dims,
      };
    }
    case "pow": {
      const base = evalSTree(t[1]);
      const exp = evalSTree(t[2]);
      if (!exp.value.isInteger) throw new Error("stree: non-integer exponent");
      const e = Number(exp.value.num);
      return { value: base.value.pow(e), dims: dimsScale(base.dims, e) };
    }
  }
}
