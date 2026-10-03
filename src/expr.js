import { PlannerError, CODES } from './errors.js';

const INFIX_BP = { '|': 10, '&': 20 };

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '&' || ch === '|' || ch === '!' || ch === '(' || ch === ')' || ch === ':') {
      tokens.push({ kind: ch });
      i += 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(src.slice(i));
    if (m) {
      tokens.push({ kind: 'ident', value: m[0] });
      i += m[0].length;
      continue;
    }
    throw new PlannerError(CODES.PARSE, `unexpected character ${JSON.stringify(ch)} at position ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// Pratt parser. Precedence (loosest to tightest): |  &  !  () ref
// ref := ident | ident ':' ident   (optional artifact-type qualifier, e.g. file:model.bin)
export function parseExpression(src) {
  if (typeof src !== 'string') {
    throw new PlannerError(CODES.FIELD_TYPE, `expression must be a string, got ${typeof src}`);
  }
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];

  function expect(kind) {
    if (tokens[pos].kind !== kind) {
      throw new PlannerError(CODES.PARSE, `expected ${JSON.stringify(kind)} but found ${JSON.stringify(tokens[pos].kind)}`);
    }
    pos += 1;
  }

  function parseRef() {
    const tok = tokens[pos];
    if (tok.kind !== 'ident') {
      throw new PlannerError(CODES.PARSE, `expected an artifact reference but found ${JSON.stringify(tok.kind)}`);
    }
    pos += 1;
    if (peek().kind === ':') {
      pos += 1;
      const nameTok = tokens[pos];
      if (nameTok.kind !== 'ident') {
        throw new PlannerError(CODES.PARSE, `expected an artifact name after ':' but found ${JSON.stringify(nameTok.kind)}`);
      }
      pos += 1;
      return { kind: 'ref', type: tok.value, name: nameTok.value };
    }
    return { kind: 'ref', type: null, name: tok.value };
  }

  function parsePrefix() {
    const tok = tokens[pos];
    if (tok.kind === '!') {
      pos += 1;
      return { kind: 'not', operand: parsePrefix() };
    }
    if (tok.kind === '(') {
      pos += 1;
      const inner = parseExpr(0);
      expect(')');
      return inner;
    }
    return parseRef();
  }

  function parseExpr(minBp) {
    let lhs = parsePrefix();
    for (;;) {
      const bp = INFIX_BP[peek().kind];
      if (bp === undefined || bp < minBp) return lhs;
      const op = peek().kind;
      pos += 1;
      const rhs = parseExpr(bp + 1);
      lhs = { kind: op === '&' ? 'and' : 'or', left: lhs, right: rhs };
    }
  }

  const ast = parseExpr(0);
  if (peek().kind !== 'eof') {
    throw new PlannerError(CODES.PARSE, `unexpected trailing token ${JSON.stringify(peek().kind)}`);
  }
  return ast;
}

export function evalExpression(ast, available) {
  switch (ast.kind) {
    case 'ref': return available.has(ast.name);
    case 'not': return !evalExpression(ast.operand, available);
    case 'and': return evalExpression(ast.left, available) && evalExpression(ast.right, available);
    case 'or': return evalExpression(ast.left, available) || evalExpression(ast.right, available);
    default: throw new PlannerError(CODES.PARSE, `unknown AST node kind ${JSON.stringify(ast.kind)}`);
  }
}

export function collectRefs(ast, out = []) {
  if (ast.kind === 'ref') out.push(ast);
  else if (ast.kind === 'not') collectRefs(ast.operand, out);
  else if (ast.kind === 'and' || ast.kind === 'or') {
    collectRefs(ast.left, out);
    collectRefs(ast.right, out);
  }
  return out;
}
