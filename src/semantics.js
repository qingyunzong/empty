'use strict';

// Static semantics: lexical scopes, alias resolution, static types
// (evidence | rule | claim), term normalization and dependency closure.

const crypto = require('node:crypto');

class Scope {
  constructor(parent, label) {
    this.parent = parent;
    this.label = label;
    this.entries = new Map();
  }

  declare(name, entry) {
    if (this.entries.has(name)) {
      throw new Error(`duplicate declaration of '${name}' in scope ${this.label}`);
    }
    this.entries.set(name, entry);
  }

  lookup(name) {
    for (let scope = this; scope !== null; scope = scope.parent) {
      if (scope.entries.has(name)) return scope.entries.get(name);
    }
    return null;
  }

  path() {
    const parts = [];
    for (let scope = this; scope !== null; scope = scope.parent) parts.push(scope.label);
    return parts.reverse().join('/');
  }

  visibleAliases() {
    const aliases = new Map();
    const chain = [];
    for (let scope = this; scope !== null; scope = scope.parent) chain.unshift(scope);
    for (const scope of chain) {
      for (const [name, entry] of scope.entries) {
        if (entry.kind === 'alias') aliases.set(name, entry.normalized);
      }
    }
    return aliases;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function scopeHash(scope) {
  const aliases = scope.visibleAliases();
  const rendered = [...aliases.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',');
  return sha256(`scope:${scope.path()}|aliases:${rendered}`);
}

// Static type of an expression. Rules may only appear as the right operand
// of `|>`; everything else composes into claims.
function typeOfExpr(expr, scope) {
  if (expr.kind === 'ref') {
    const entry = scope.lookup(expr.name);
    if (entry === null) {
      throw new Error(`unknown identifier '${expr.name}' (not declared in any visible scope)`);
    }
    return entry.type;
  }
  const left = typeOfExpr(expr.left, scope);
  const right = typeOfExpr(expr.right, scope);
  if (expr.op === '|>') {
    if (right !== 'rule') {
      throw new Error(`type error: right operand of '|>' must be a rule, got ${right}`);
    }
    if (left === 'rule') {
      throw new Error("type error: left operand of '|>' must be evidence or claim, got rule");
    }
    return 'claim';
  }
  if (expr.op === '&') {
    if (left === 'rule' || right === 'rule') {
      throw new Error("type error: operands of '&' must be evidence or claim, not rule");
    }
    return 'claim';
  }
  if (expr.op === 'requires') {
    if (left !== 'claim') {
      throw new Error(`type error: left operand of 'requires' must be a claim, got ${left}`);
    }
    if (right === 'rule') {
      throw new Error("type error: right operand of 'requires' must be evidence or claim, not rule");
    }
    return 'claim';
  }
  throw new Error(`unknown operator ${expr.op}`);
}

// Canonical term: aliases fully expanded, fully parenthesized infix form,
// `&` flattened and sorted so that equivalent conjunctions normalize to
// the same string.
function normalizeExpr(expr, scope) {
  if (expr.kind === 'ref') {
    const entry = scope.lookup(expr.name);
    if (entry === null) {
      throw new Error(`unknown identifier '${expr.name}' (not declared in any visible scope)`);
    }
    return entry.kind === 'alias' ? entry.normalized : expr.name;
  }
  if (expr.op === '&') {
    const parts = [];
    const collect = (node) => {
      if (node.kind === 'bin' && node.op === '&') {
        collect(node.left);
        collect(node.right);
      } else {
        parts.push(normalizeExpr(node, scope));
      }
    };
    collect(expr);
    parts.sort();
    return `(${parts.join(' & ')})`;
  }
  return `(${normalizeExpr(expr.left, scope)} ${expr.op} ${normalizeExpr(expr.right, scope)})`;
}

// Transitive evidence dependencies of an expression (aliases expanded,
// claims resolved through their own recorded dependency sets).
function depsOfExpr(expr, scope, into) {
  if (expr.kind === 'ref') {
    const entry = scope.lookup(expr.name);
    if (entry === null) {
      throw new Error(`unknown identifier '${expr.name}' (not declared in any visible scope)`);
    }
    for (const dep of entry.deps) into.add(dep);
    return;
  }
  depsOfExpr(expr.left, scope, into);
  depsOfExpr(expr.right, scope, into);
}

// Elaborate a parsed program into an ordered commit list. Every declaration
// (evidence, rule, alias, claim) becomes one commit carrying its normalized
// term, dependency closure and scope hash.
function elaborate(program) {
  const commits = [];
  let blockCounter = 0;

  const walk = (statements, scope) => {
    for (const stmt of statements) {
      if (stmt.kind === 'block') {
        blockCounter += 1;
        walk(stmt.body, new Scope(scope, `block${blockCounter}`));
        continue;
      }
      if (stmt.kind === 'evidenceDecl' || stmt.kind === 'ruleDecl') {
        const kind = stmt.kind === 'evidenceDecl' ? 'evidence' : 'rule';
        const entry = {
          kind,
          type: kind,
          normalized: stmt.name,
          deps: kind === 'evidence' ? [stmt.name] : [],
        };
        scope.declare(stmt.name, entry);
        commits.push({
          id: stmt.name,
          kind,
          type: kind,
          term: stmt.name,
          deps: entry.deps.slice(),
          scope: scopeHash(scope),
        });
        continue;
      }
      if (stmt.kind === 'aliasDecl' || stmt.kind === 'claimDecl') {
        const kind = stmt.kind === 'aliasDecl' ? 'alias' : 'claim';
        const type = typeOfExpr(stmt.expr, scope);
        if (kind === 'claim' && type !== 'claim') {
          throw new Error(
            `type error: claim '${stmt.name}' must be bound to a claim-typed expression, got ${type}`,
          );
        }
        const normalized = normalizeExpr(stmt.expr, scope);
        const depSet = new Set();
        depsOfExpr(stmt.expr, scope, depSet);
        const deps = [...depSet].sort();
        scope.declare(stmt.name, { kind, type, normalized, deps });
        commits.push({
          id: stmt.name,
          kind,
          type,
          term: normalized,
          deps,
          scope: scopeHash(scope),
        });
        continue;
      }
      throw new Error(`unknown statement kind ${stmt.kind}`);
    }
  };

  walk(program.body, new Scope(null, '<root>'));
  return commits;
}

module.exports = { Scope, scopeHash, typeOfExpr, normalizeExpr, depsOfExpr, elaborate };
