'use strict';

function addConst(consts, value) {
  consts.push(value);
  return consts.length - 1;
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function emitExpr(node, env, consts, regexes, out) {
  switch (node.type) {
    case 'lit':
      out.push({ op: 'push', k: addConst(consts, node.value) });
      return;
    case 'ref':
      if (env.has(node.name)) out.push({ op: 'load_slot', slot: env.get(node.name) });
      else out.push({ op: 'load_field', field: node.name });
      return;
    case 'not':
      emitExpr(node.operand, env, consts, regexes, out);
      out.push({ op: 'not' });
      return;
    case 'logic': {
      emitExpr(node.left, env, consts, regexes, out);
      const jmpIdx = out.length;
      out.push({ op: node.op === 'and' ? 'jmp_false' : 'jmp_true', to: 0 });
      emitExpr(node.right, env, consts, regexes, out);
      out[jmpIdx].to = out.length;
      return;
    }
    case 'cmp': {
      emitExpr(node.left, env, consts, regexes, out);
      if (node.op === 'matches') {
        regexes.push(globToRegex(node.right.value));
        out.push({ op: 'matches', re: regexes.length - 1 });
        return;
      }
      emitExpr(node.right, env, consts, regexes, out);
      out.push({ op: node.op });
      return;
    }
    default:
      throw new Error(`internal: cannot compile node type '${node.type}'`);
  }
}

function compileExpr(node, env, consts, regexes) {
  const out = [];
  emitExpr(node, env, consts, regexes, out);
  return out;
}

const FLIP = { lt: 'gt', le: 'ge', gt: 'lt', ge: 'le', eq: 'eq', ne: 'ne' };

function collectTsConstraints(node, out) {
  if (node.type === 'logic' && node.op === 'and') {
    collectTsConstraints(node.left, out);
    collectTsConstraints(node.right, out);
    return;
  }
  if (node.type !== 'cmp') return;
  const { op, left, right } = node;
  if (left.type === 'ref' && left.name === 'ts' && right.type === 'lit' && right.litType === 'time') {
    out.push({ op, value: right.value });
  } else if (right.type === 'ref' && right.name === 'ts' && left.type === 'lit' && left.litType === 'time') {
    out.push({ op: FLIP[op], value: left.value });
  }
}

function extractBounds(where) {
  const constraints = [];
  collectTsConstraints(where, constraints);
  if (constraints.length === 0) return null;
  let lo = -Infinity;
  let hi = Infinity;
  for (const c of constraints) {
    switch (c.op) {
      case 'gt': lo = Math.max(lo, c.value + 1); break;
      case 'ge': lo = Math.max(lo, c.value); break;
      case 'lt': hi = Math.min(hi, c.value - 1); break;
      case 'le': hi = Math.min(hi, c.value); break;
      case 'eq': lo = Math.max(lo, c.value); hi = Math.min(hi, c.value); break;
      default: return null;
    }
  }
  return { lo, hi };
}

function compile(program) {
  const consts = [];
  const regexes = [];
  const env = new Map();
  const slots = program.lets.map((decl, i) => {
    const code = compileExpr(decl.expr, env, consts, regexes);
    env.set(decl.name, i);
    return code;
  });
  const main = program.where
    ? compileExpr(program.where, env, consts, regexes)
    : [{ op: 'push', k: addConst(consts, true) }];
  const bounds = program.where ? extractBounds(program.where) : null;
  return { slots, main, select: program.select, consts, regexes, bounds };
}

module.exports = { compile, extractBounds, globToRegex };
