// Compiles typed expressions into stack-machine bytecode. Constants are folded
// at compile time; the only runtime inputs are ingredient gram amounts.

import { UNITS } from './parser.js';
import { radd, rsub, rmul, rdiv, rneg } from './rational.js';

export const OP = {
  PUSH: 'PUSH',   // { n, d } rational constant (BigInt numerator/denominator)
  LOAD: 'LOAD',   // push grams of ingredient at index arg
  ADD: 'ADD',
  SUB: 'SUB',
  MUL: 'MUL',
  DIV: 'DIV',
  NEG: 'NEG',
};

// Returns { code, constant } where constant is a rational if the expression
// does not depend on any .grams variable.
function compileNode(node, ctx, code) {
  switch (node.kind) {
    case 'num':
      code.push({ op: OP.PUSH, n: node.value.n, d: node.value.d });
      return node.value;
    case 'unit': {
      const scale = UNITS[node.name].scale;
      code.push({ op: OP.PUSH, n: scale.n, d: scale.d });
      return scale;
    }
    case 'attr': {
      if (node.attr === 'grams') {
        const idx = ctx.gramIndex(node.ingredient);
        code.push({ op: OP.LOAD, arg: idx });
        return null;
      }
      const value = ctx.attrValue(node);
      code.push({ op: OP.PUSH, n: value.n, d: value.d });
      return value;
    }
    case 'neg': {
      const c = compileNode(node.operand, ctx, code);
      if (c) return rneg(c);
      code.push({ op: OP.NEG });
      return null;
    }
    case 'bin': {
      // Compile into a temporary buffer so constant folding can discard it.
      const buf = [];
      const cl = compileNode(node.lhs, ctx, buf);
      const cr = compileNode(node.rhs, ctx, buf);
      if (cl && cr) {
        const folded = fold(node.op, cl, cr, node, ctx);
        code.push({ op: OP.PUSH, n: folded.n, d: folded.d });
        return folded;
      }
      for (const ins of buf) code.push(ins);
      code.push({ op: { '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV }[node.op] });
      return null;
    }
    default:
      throw new Error(`cannot compile node kind ${node.kind}`);
  }
}

function fold(op, l, r, node, ctx) {
  switch (op) {
    case '+': return radd(l, r);
    case '-': return rsub(l, r);
    case '*': return rmul(l, r);
    case '/':
      if (r.n === 0n) ctx.error('division by zero in constant expression', node);
      return rdiv(l, r);
    default: throw new Error(`bad op ${op}`);
  }
}

export function compileExpr(node, ctx) {
  const code = [];
  compileNode(node, ctx, code);
  return code;
}

// ctx: { gramIndex(name) -> index, attrValue(node) -> rational, error(msg, node) }
export function compileModel(model) {
  const names = model.ingredients.map((i) => i.name);
  const ctx = {
    gramIndex(name) {
      const idx = names.indexOf(name);
      if (idx < 0) throw new Error(`compiler lost ingredient ${name}`);
      return idx;
    },
    attrValue(attrNode) {
      const ing = model.ingredients.find((i) => i.name === attrNode.ingredient);
      return ing.attrs.get(attrNode.attr).value;
    },
    error(message) {
      throw new Error(message);
    },
  };
  const objective = compileExpr(model.objective, ctx);
  const constraints = model.constraints.map((c) => ({
    op: c.op,
    line: c.line,
    col: c.col,
    lhs: compileExpr(c.lhs, ctx),
    rhs: compileExpr(c.rhs, ctx),
  }));
  return { objective, constraints };
}
