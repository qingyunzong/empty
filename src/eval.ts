import { Node } from "./ast";
import { Rational } from "./rational";
import {
  Dims, DIMENSIONLESS, dimsAdd, dimsSub, dimsScale, dimsEqual, canonicalUnit,
} from "./dims";
import { lookupUnit } from "./units";

export interface Quantity {
  value: Rational;
  dims: Dims;
}

/** Error raised during evaluation; carries the range of the offending subexpression. */
export class UnitError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number,
    /** Canonical units of the mismatched sides, when applicable. */
    readonly leftUnit?: string,
    readonly rightUnit?: string,
    readonly leftRange?: { start: number; end: number },
    readonly rightRange?: { start: number; end: number },
  ) {
    super(message);
    this.name = "UnitError";
  }
}

export function evalNode(node: Node): Quantity {
  switch (node.kind) {
    case "num":
      return { value: Rational.parse(node.raw), dims: DIMENSIONLESS };
    case "unit": {
      const def = lookupUnit(node.name);
      if (!def) {
        throw new UnitError(`unknown unit '${node.name}'`, node.start, node.end);
      }
      return { value: def.factor, dims: def.dims };
    }
    case "neg": {
      const q = evalNode(node.operand);
      return { value: q.value.neg(), dims: q.dims };
    }
    case "pow": {
      const base = evalNode(node.base);
      const exp = evalNode(node.exponent);
      if (!dimsEqual(exp.dims, DIMENSIONLESS)) {
        throw new UnitError(
          `exponent must be dimensionless, got '${canonicalUnit(exp.dims)}'`,
          node.exponent.start, node.exponent.end,
        );
      }
      if (!exp.value.isInteger) {
        throw new UnitError(
          `exponent must be an integer, got '${exp.value}'`,
          node.exponent.start, node.exponent.end,
        );
      }
      const e = Number(exp.value.num);
      try {
        return { value: base.value.pow(e), dims: dimsScale(base.dims, e) };
      } catch {
        throw new UnitError(`exponent ${e} out of range`, node.exponent.start, node.exponent.end);
      }
    }
    case "bin": {
      const l = evalNode(node.left);
      const r = evalNode(node.right);
      switch (node.op) {
        case "*":
          return { value: l.value.mul(r.value), dims: dimsAdd(l.dims, r.dims) };
        case "/":
          if (r.value.isZero) {
            throw new UnitError("division by zero", node.right.start, node.right.end);
          }
          return { value: l.value.div(r.value), dims: dimsSub(l.dims, r.dims) };
        case "+":
        case "-": {
          // Zero is NOT exempt: dimensions must match even when a side is 0.
          if (!dimsEqual(l.dims, r.dims)) {
            const lu = canonicalUnit(l.dims);
            const ru = canonicalUnit(r.dims);
            throw new UnitError(
              `cannot ${node.op === "+" ? "add" : "subtract"} '${ru}' ${
                node.op === "+" ? "to" : "from"} '${lu}'`,
              node.start, node.end, lu, ru,
              { start: node.left.start, end: node.left.end },
              { start: node.right.start, end: node.right.end },
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
}
