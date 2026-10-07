import { parse } from './parser.js';
import { check, evalConst } from './check.js';

const BIN_OP = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
  '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
  and: 'AND', or: 'OR',
};
const LOAD_FN = { available: 'LOAD_AVAIL', frozen: 'LOAD_FROZEN', limit: 'LOAD_LIMIT', used: 'LOAD_USED' };

export function compileSource(src) { return compile(parse(src)); }

export function compile(prog) {
  check(prog);
  const buckets = prog.buckets.map((b) => ({
    name: b.name, limit: b.limit, validFrom: b.validFrom, validTo: b.validTo,
  }));
  const bucketIndex = Object.fromEntries(buckets.map((b, i) => [b.name, i]));
  const scopeIndex = {};
  const scopes = prog.approvals.map((a) => compileScope(a, [], {}, bucketIndex, scopeIndex));
  return { customer: prog.customer, noteRegex: prog.note, buckets, bucketIndex, scopes, scopeIndex };
}

function compileScope(node, path, parentLets, bucketIndex, scopeIndex) {
  const here = path.concat(node.name);
  const key = here.join('/');
  const lets = { ...parentLets };
  for (const l of node.lets) lets[l.name] = evalConst(l.expr, lets, `let '${l.name}'`);
  const scope = { name: node.name, path: key, caps: {}, rules: [], children: [] };
  scopeIndex[key] = scope;
  for (const c of node.caps) scope.caps[c.bucket] = c.amount;
  for (const r of node.rules) scope.rules.push(compileRule(r, lets, bucketIndex));
  scope.children = node.children.map((ch) => compileScope(ch, here, lets, bucketIndex, scopeIndex));
  return scope;
}

// Bytecode layout per rule:
//   <when> JZ end ; <unless> JNZ end ; REJECT code ; end:
function compileRule(r, lets, bucketIndex) {
  const bc = [];
  genExpr(r.when, bc, lets, bucketIndex);
  const jz = bc.length;
  bc.push(['JZ', 0]);
  let jnz = null;
  if (r.unless) {
    genExpr(r.unless, bc, lets, bucketIndex);
    jnz = bc.length;
    bc.push(['JNZ', 0]);
  }
  bc.push(['REJECT', r.code, `reject ${r.op}`]);
  bc[jz][1] = bc.length;
  if (jnz !== null) bc[jnz][1] = bc.length;
  return { op: r.op, code: r.code, bc };
}

function genExpr(e, bc, lets, bucketIndex) {
  switch (e.k) {
    case 'num': bc.push(['PUSH', e.v]); break;
    case 'bool': bc.push(['PUSH', e.v ? 1 : 0]); break;
    case 'str': bc.push(['PUSH', e.v]); break;
    case 'amount': bc.push(['LOAD_AMOUNT']); break;
    case 'note': bc.push(['LOAD_NOTE']); break;
    case 'var': bc.push(['PUSH', lets[e.name]]); break;
    case 'call': bc.push([LOAD_FN[e.fn], bucketIndex[e.bucket]]); break;
    case 'un':
      genExpr(e.e, bc, lets, bucketIndex);
      bc.push([e.op === 'neg' ? 'NEG' : 'NOT']);
      break;
    case 'bin':
      genExpr(e.l, bc, lets, bucketIndex);
      genExpr(e.r, bc, lets, bucketIndex);
      bc.push([BIN_OP[e.op]]);
      break;
    case 'match':
      genExpr(e.left, bc, lets, bucketIndex);
      bc.push(['MATCH', e.re]);
      break;
    default:
      throw new Error(`cannot compile expression kind '${e.k}'`);
  }
}
