import { createHash } from 'node:crypto';
import { dimVector } from './dimensions.js';

function canonicalAst(node) {
  switch (node.type) {
    case 'num': return ['num', node.value];
    case 'var': return ['var', node.name];
    case 'neg': return ['neg', canonicalAst(node.arg)];
    case 'bin': return ['bin', node.op, canonicalAst(node.left), canonicalAst(node.right)];
    case 'call': return ['call', node.fn, canonicalAst(node.arg)];
    case 'assign': return ['assign', node.target.name, canonicalAst(node.right)];
    default: throw new Error(`cannot canonicalize ${node.type}`);
  }
}

export function dimensionTable(env) {
  const table = {};
  for (const name of Object.keys(env).sort()) {
    table[name] = dimVector(env[name]);
  }
  return table;
}

export function certificate(ast, env) {
  const payload = JSON.stringify({ ast: canonicalAst(ast), dims: dimensionTable(env) });
  return createHash('sha256').update(payload).digest('hex');
}
