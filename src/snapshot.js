// Immutable snapshots: each parse/correct produces a snapshot with a version
// and a parentVersion. Scopes are addressed by path and resolved through the
// snapshot's own scope map, so snapshots can share unchanged subtrees.
import { parseProgram, parseExpression } from './parser.js';

export class ResolveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolveError';
  }
}

export class OverrideError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OverrideError';
  }
}

export class DuplicateBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DuplicateBindingError';
  }
}

let versionCounter = 1;

const ROOT_PATH = 'root';

export function normalizeScopePath(scopePath) {
  if (!scopePath || scopePath === ROOT_PATH) return ROOT_PATH;
  return scopePath.startsWith(ROOT_PATH + '.') ? scopePath : ROOT_PATH + '.' + scopePath;
}

function parentPath(path) {
  const idx = path.lastIndexOf('.');
  return idx < 0 ? null : path.slice(0, idx);
}

function scopeName(path) {
  const idx = path.lastIndexOf('.');
  return idx < 0 ? path : path.slice(idx + 1);
}

function makeScope(path) {
  return { path, name: scopeName(path), bindings: new Map(), children: [] };
}

// Build a fresh snapshot from a parsed program.
export function createSnapshot(source) {
  const program = typeof source === 'string' ? parseProgram(source) : source;
  const scopes = new Map();
  const root = makeScope(ROOT_PATH);
  scopes.set(ROOT_PATH, root);
  buildStatements(program.body, root, scopes);
  return { version: versionCounter++, parentVersion: null, scopes, cache: new Map() };
}

function buildStatements(stmts, scope, scopes) {
  for (const stmt of stmts) {
    if (stmt.kind === 'experiment') {
      const childPath = scope.path + '.' + stmt.name;
      if (scopes.has(childPath)) {
        throw new DuplicateBindingError(`duplicate experiment '${stmt.name}' in scope '${scope.path}'`);
      }
      const child = makeScope(childPath);
      scopes.set(childPath, child);
      scope.children.push(childPath);
      buildStatements(stmt.body, child, scopes);
    } else if (stmt.kind === 'let') {
      if (scope.bindings.has(stmt.name)) {
        throw new DuplicateBindingError(`duplicate binding '${stmt.name}' in scope '${scope.path}'`);
      }
      scope.bindings.set(stmt.name, { name: stmt.name, expr: stmt.expr });
    } else if (stmt.kind === 'override') {
      const target = findBindingScope(scopes, scope.path, stmt.name);
      if (!target) {
        throw new OverrideError(`override of undefined binding '${stmt.name}' in scope '${scope.path}'`);
      }
      target.bindings.set(stmt.name, { name: stmt.name, expr: stmt.expr });
    }
  }
}

// Walk the scope chain from `path` to root, return the scope object holding `name`.
function findBindingScope(scopes, path, name) {
  let current = path;
  while (current !== null) {
    const scope = scopes.get(current);
    if (!scope) throw new ResolveError(`unknown scope '${current}'`);
    if (scope.bindings.has(name)) return scope;
    current = parentPath(current);
  }
  return null;
}

function evalExpr(snapshot, expr, defPath) {
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'raw':
      return expr.value;
    case 'ref': {
      const target = findBindingScope(snapshot.scopes, defPath, expr.name);
      if (!target) {
        throw new ResolveError(`unknown name '${expr.name}' referenced from scope '${defPath}'`);
      }
      return evalBinding(snapshot, target.bindings.get(expr.name), target.path);
    }
    case 'neg': {
      const v = evalExpr(snapshot, expr.expr, defPath);
      if (typeof v !== 'number') throw new ResolveError(`cannot negate non-number value`);
      return -v;
    }
    case 'bin': {
      const l = evalExpr(snapshot, expr.left, defPath);
      const r = evalExpr(snapshot, expr.right, defPath);
      if (expr.op === '+') {
        if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r);
        return l + r;
      }
      if (typeof l !== 'number' || typeof r !== 'number') {
        throw new ResolveError(`operator '${expr.op}' requires numbers`);
      }
      if (expr.op === '-') return l - r;
      if (expr.op === '*') return l * r;
      if (expr.op === '/') return l / r;
      throw new ResolveError(`unknown operator '${expr.op}'`);
    }
    default:
      throw new ResolveError(`unknown expr kind ${expr.kind}`);
  }
}

function evalBinding(snapshot, binding, defPath) {
  if (snapshot.cache.has(binding)) return snapshot.cache.get(binding);
  const value = evalExpr(snapshot, binding.expr, defPath);
  snapshot.cache.set(binding, value);
  return value;
}

// Resolve `name` as seen from `scopePath`; returns value plus the full scope chain.
export function resolve(snapshot, name, scopePath = ROOT_PATH) {
  const startPath = normalizeScopePath(scopePath);
  if (!snapshot.scopes.has(startPath)) throw new ResolveError(`unknown scope '${startPath}'`);
  const chain = [];
  let found = null;
  let current = startPath;
  while (current !== null) {
    const scope = snapshot.scopes.get(current);
    const binding = scope.bindings.get(name);
    chain.push({ scope: scope.name, path: current, hasBinding: Boolean(binding) });
    if (binding && !found) found = { binding, path: current };
    current = parentPath(current);
  }
  if (!found) {
    throw new ResolveError(`unknown name '${name}' in scope chain of '${startPath}'`);
  }
  return {
    name,
    value: evalBinding(snapshot, found.binding, found.path),
    definedIn: found.path,
    chain,
  };
}

// Visible bindings table as seen from `scopePath` (inner scopes shadow outer).
export function visibleBindings(snapshot, scopePath = ROOT_PATH) {
  const startPath = normalizeScopePath(scopePath);
  if (!snapshot.scopes.has(startPath)) throw new ResolveError(`unknown scope '${startPath}'`);
  const table = new Map();
  let current = startPath;
  while (current !== null) {
    const scope = snapshot.scopes.get(current);
    for (const [name, binding] of scope.bindings) {
      if (!table.has(name)) {
        table.set(name, { name, value: evalBinding(snapshot, binding, current), definedIn: current });
      }
    }
    current = parentPath(current);
  }
  return table;
}

export function visibleValues(snapshot, scopePath = ROOT_PATH) {
  const out = {};
  for (const [name, entry] of visibleBindings(snapshot, scopePath)) out[name] = entry.value;
  return out;
}

// Incrementally replace one existing binding, producing a new snapshot whose
// parentVersion is the given snapshot's version. The parent is untouched.
export function correct(snapshot, name, exprSource, scopePath = ROOT_PATH) {
  const expr = typeof exprSource === 'string' ? parseExpression(exprSource) : exprSource;
  const startPath = normalizeScopePath(scopePath);
  if (!snapshot.scopes.has(startPath)) throw new ResolveError(`unknown scope '${startPath}'`);
  const target = findBindingScope(snapshot.scopes, startPath, name);
  if (!target) {
    throw new OverrideError(`cannot correct undefined binding '${name}' in scope chain of '${startPath}'`);
  }
  // Path-copy the scope chain from root down to the target scope.
  const segments = target.path === ROOT_PATH ? [] : target.path.slice(ROOT_PATH.length + 1).split('.');
  const newScopes = new Map(snapshot.scopes);
  let oldNode = snapshot.scopes.get(ROOT_PATH);
  let newNode = { ...oldNode, bindings: new Map(oldNode.bindings), children: [...oldNode.children] };
  newScopes.set(ROOT_PATH, newNode);
  for (const seg of segments) {
    const childPath = newNode.path === ROOT_PATH ? ROOT_PATH + '.' + seg : newNode.path + '.' + seg;
    oldNode = snapshot.scopes.get(childPath);
    newNode = { ...oldNode, bindings: new Map(oldNode.bindings), children: [...oldNode.children] };
    newScopes.set(childPath, newNode);
  }
  newNode.bindings.set(name, { name, expr });
  return {
    version: versionCounter++,
    parentVersion: snapshot.version,
    scopes: newScopes,
    cache: new Map(),
  };
}
