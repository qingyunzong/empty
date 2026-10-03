'use strict';

class CheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckError';
  }
}

const EVIDENCE = 'evidence';
const RULE = 'rule';
const CLAIM = 'claim';

function typeOfBin(op, left, right) {
  if (op === '|>') {
    if (right.type !== RULE) {
      throw new CheckError(`operator |> expects a rule on the right, got ${right.type}`);
    }
    if (left.type !== EVIDENCE && left.type !== CLAIM) {
      throw new CheckError(`operator |> expects evidence or claim on the left, got ${left.type}`);
    }
    return { type: CLAIM, deps: new Set(left.deps) };
  }
  if (op === '&') {
    if (left.type === RULE || right.type === RULE) {
      throw new CheckError('operator & cannot combine rules');
    }
    if (left.type !== right.type) {
      throw new CheckError(`operator & cannot combine ${left.type} with ${right.type}`);
    }
    return { type: left.type, deps: new Set([...left.deps, ...right.deps]) };
  }
  if (op === 'requires') {
    if (left.type !== CLAIM) {
      throw new CheckError(`operator requires expects a claim on the left, got ${left.type}`);
    }
    if (right.type !== EVIDENCE && right.type !== CLAIM) {
      throw new CheckError(`operator requires expects evidence or claim on the right, got ${right.type}`);
    }
    return { type: CLAIM, deps: new Set([...left.deps, ...right.deps]) };
  }
  throw new CheckError(`unknown operator ${op}`);
}

function lookupAlias(name, scope) {
  for (let s = scope; s; s = s.parent) {
    if (s.aliases.has(name)) return s.aliases.get(name);
  }
  return null;
}

// Evaluate an expression AST in a scope: static type, canonical form, evidence deps.
function evalExpr(expr, scope, symbols) {
  if (expr.kind === 'ref') {
    const alias = lookupAlias(expr.name, scope);
    if (alias) return { ...alias.value, deps: new Set(alias.value.deps) };
    const sym = symbols.get(expr.name);
    if (!sym) throw new CheckError(`unknown identifier "${expr.name}"`);
    if (sym.type === EVIDENCE) return { type: EVIDENCE, canon: expr.name, deps: new Set([expr.name]) };
    if (sym.type === RULE) return { type: RULE, canon: expr.name, deps: new Set() };
    return { type: CLAIM, canon: expr.name, deps: new Set(sym.deps) };
  }
  if (expr.kind === 'bin') {
    const left = evalExpr(expr.left, scope, symbols);
    const right = evalExpr(expr.right, scope, symbols);
    const typed = typeOfBin(expr.op, left, right);
    if (expr.op === '&') {
      const parts = [...(left.parts || [left.canon]), ...(right.parts || [right.canon])].sort();
      return { ...typed, canon: `(${parts.join(' & ')})`, parts };
    }
    return { ...typed, canon: `(${left.canon} ${expr.op} ${right.canon})` };
  }
  throw new CheckError('malformed expression');
}

// Parser for canonical term strings (aliases already expanded, & sorted).
function parseCanonical(src) {
  let pos = 0;
  const fail = () => { throw new CheckError(`malformed canonical term: ${JSON.stringify(src)}`); };
  const skipWs = () => { while (src[pos] === ' ') pos += 1; };
  function parseNode() {
    skipWs();
    if (src[pos] === '(') {
      pos += 1;
      const left = parseNode();
      skipWs();
      let op;
      if (src.startsWith('|>', pos)) { op = '|>'; pos += 2; }
      else if (src[pos] === '&') { op = '&'; pos += 1; }
      else if (src.startsWith('requires', pos)) { op = 'requires'; pos += 'requires'.length; }
      else fail();
      const right = parseNode();
      skipWs();
      if (src[pos] !== ')') fail();
      pos += 1;
      return { kind: 'bin', op, left, right };
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos));
    if (!m) fail();
    pos += m[0].length;
    return { kind: 'ref', name: m[0] };
  }
  const ast = parseNode();
  skipWs();
  if (pos !== src.length) fail();
  return ast;
}

function typeCheckAst(expr, symbols) {
  if (expr.kind === 'ref') {
    const sym = symbols.get(expr.name);
    if (!sym) throw new CheckError(`unknown identifier "${expr.name}"`);
    if (sym.type === EVIDENCE) return { type: EVIDENCE, deps: new Set([expr.name]) };
    if (sym.type === RULE) return { type: RULE, deps: new Set() };
    return { type: CLAIM, deps: new Set(sym.deps) };
  }
  const left = typeCheckAst(expr.left, symbols);
  const right = typeCheckAst(expr.right, symbols);
  return typeOfBin(expr.op, left, right);
}

// Re-check a canonical term against previously verified commits.
function typeCheckCanonical(term, symbols) {
  return typeCheckAst(parseCanonical(term), symbols);
}

module.exports = {
  CheckError, EVIDENCE, RULE, CLAIM,
  typeOfBin, lookupAlias, evalExpr, parseCanonical, typeCheckCanonical,
};
