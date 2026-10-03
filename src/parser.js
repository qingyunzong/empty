import { PlanError } from './errors.js';

const BINDING_POWER = { OR: 10, AND: 20 };
const NOT_BINDING_POWER = 30;

export function tokenize(source) {
  if (typeof source !== 'string') {
    throw new PlanError('E_EXPR_TYPE', 'dependency expression must be a string');
  }
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '&') { tokens.push({ type: 'AND' }); i += 1; continue; }
    if (ch === '|') { tokens.push({ type: 'OR' }); i += 1; continue; }
    if (ch === '!') { tokens.push({ type: 'NOT' }); i += 1; continue; }
    if (ch === '(') { tokens.push({ type: 'LPAREN' }); i += 1; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN' }); i += 1; continue; }
    const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(i));
    if (match) {
      tokens.push({ type: 'IDENT', value: match[0] });
      i += match[0].length;
      continue;
    }
    throw new PlanError('E_EXPR_TOKEN', `unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  return tokens;
}

function describeToken(tok) {
  if (tok.type === 'IDENT') return `identifier "${tok.value}"`;
  return `token ${tok.type}`;
}

// Pratt parser. Precedence (tightest first): !, &, |. & and | are left-associative.
export function parseExpression(source) {
  const tokens = tokenize(source);
  let pos = 0;

  function parseExpr(minBp) {
    const tok = tokens[pos];
    if (!tok) throw new PlanError('E_EXPR_SYNTAX', 'unexpected end of expression');
    pos += 1;
    let lhs;
    if (tok.type === 'IDENT') {
      lhs = { kind: 'ref', name: tok.value };
    } else if (tok.type === 'NOT') {
      lhs = { kind: 'not', operand: parseExpr(NOT_BINDING_POWER) };
    } else if (tok.type === 'LPAREN') {
      lhs = parseExpr(0);
      const close = tokens[pos];
      if (!close || close.type !== 'RPAREN') {
        throw new PlanError('E_EXPR_SYNTAX', 'missing closing parenthesis');
      }
      pos += 1;
    } else {
      throw new PlanError('E_EXPR_SYNTAX', `unexpected ${describeToken(tok)}`);
    }
    for (;;) {
      const op = tokens[pos];
      if (!op || (op.type !== 'AND' && op.type !== 'OR')) break;
      const bp = BINDING_POWER[op.type];
      if (bp < minBp) break;
      pos += 1;
      const rhs = parseExpr(bp + 1);
      lhs = { kind: op.type === 'AND' ? 'and' : 'or', left: lhs, right: rhs };
    }
    return lhs;
  }

  const ast = parseExpr(0);
  if (pos !== tokens.length) {
    throw new PlanError('E_EXPR_SYNTAX', `unexpected trailing ${describeToken(tokens[pos])}`);
  }
  return ast;
}

export function evaluate(node, has) {
  switch (node.kind) {
    case 'ref': return Boolean(has(node.name));
    case 'not': return !evaluate(node.operand, has);
    case 'and': return evaluate(node.left, has) && evaluate(node.right, has);
    case 'or': return evaluate(node.left, has) || evaluate(node.right, has);
    default: throw new PlanError('E_EXPR_AST', `unknown node kind ${JSON.stringify(node.kind)}`);
  }
}

export function collectRefs(node, into = new Set()) {
  switch (node.kind) {
    case 'ref': into.add(node.name); break;
    case 'not': collectRefs(node.operand, into); break;
    case 'and':
    case 'or':
      collectRefs(node.left, into);
      collectRefs(node.right, into);
      break;
    default: throw new PlanError('E_EXPR_AST', `unknown node kind ${JSON.stringify(node.kind)}`);
  }
  return into;
}
