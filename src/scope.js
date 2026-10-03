export class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
  }
}

// A scope tree node: { id, name, bindings: Map<name, {name, expr, kind}>, children: [] }
// Nodes carry no parent pointers; context is always passed as a root-to-scope path,
// which keeps snapshot trees plain, JSON-serializable data.

export function buildProgram(statements) {
  const counter = { n: 0 };
  const root = { id: 0, name: '<root>', bindings: new Map(), children: [] };
  fillScope(root, statements, counter, [root]);
  return root;
}

function newScope(counter, name) {
  return { id: ++counter.n, name, bindings: new Map(), children: [] };
}

function fillScope(scope, statements, counter, path) {
  for (const st of statements) {
    if (st.type === 'let') {
      scope.bindings.set(st.name, { name: st.name, expr: st.expr, kind: 'let' });
    } else if (st.type === 'override') {
      const found = findBindingInPath(path, st.name);
      if (!found) {
        throw new ScopeError(`override '${st.name}' has no existing binding to correct`);
      }
      found.scope.bindings.set(st.name, { name: st.name, expr: st.expr, kind: 'override' });
    } else if (st.type === 'experiment') {
      const child = newScope(counter, st.name);
      scope.children.push(child);
      fillScope(child, st.body, counter, [...path, child]);
    }
  }
}

export function pathToScope(root, scopeId) {
  const path = [];
  const visit = (node) => {
    path.push(node);
    if (node.id === scopeId) return true;
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    path.pop();
    return false;
  };
  return visit(root) ? [...path] : null;
}

export function deepestScope(root) {
  let scope = root;
  while (scope.children.length > 0) scope = scope.children[0];
  return scope;
}

// Nearest binding wins: search the path from the innermost scope outwards.
export function findBindingInPath(path, name) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i].bindings.has(name)) {
      return { scope: path[i], binding: path[i].bindings.get(name), index: i };
    }
  }
  return null;
}

export function evaluate(expr, path) {
  switch (expr.type) {
    case 'num': return expr.value;
    case 'raw': return expr.value;
    case 'neg': return -evaluate(expr.expr, path);
    case 'ref': {
      const found = findBindingInPath(path, expr.name);
      if (!found) throw new ScopeError(`unknown name '${expr.name}'`);
      return evaluate(found.binding.expr, path.slice(0, found.index + 1));
    }
    case 'bin': {
      const left = evaluate(expr.left, path);
      const right = evaluate(expr.right, path);
      switch (expr.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        default: throw new ScopeError(`unknown operator '${expr.op}'`);
      }
    }
    default:
      throw new ScopeError(`cannot evaluate expression of type '${expr.type}'`);
  }
}

// Resolve `name` starting from scope `scopeId`. Returns the value plus the full
// scope chain that was searched (innermost first) and where it was found.
export function resolve(root, scopeId, name) {
  const path = pathToScope(root, scopeId);
  if (!path) throw new ScopeError(`no scope with id ${scopeId}`);
  const found = findBindingInPath(path, name);
  if (!found) throw new ScopeError(`unknown name '${name}'`);
  const value = evaluate(found.binding.expr, path.slice(0, found.index + 1));
  return {
    name,
    value,
    kind: found.binding.kind,
    definedIn: found.scope.name,
    chain: path.map((s) => s.name).reverse(), // full chain, innermost -> root
  };
}

// Visible binding table for every scope: inner bindings shadow outer ones.
export function visibleTables(root) {
  const tables = [];
  const walk = (scope, path) => {
    const visible = new Map();
    for (const s of path) {
      for (const [n, b] of s.bindings) visible.set(n, { binding: b, scope: s });
    }
    const bindings = [...visible.entries()].map(([n, { binding, scope: defScope }]) => ({
      name: n,
      value: evaluate(binding.expr, path.slice(0, path.indexOf(defScope) + 1)),
      kind: binding.kind,
      definedIn: defScope.name,
    }));
    tables.push({ scopeId: scope.id, scopeName: scope.name, path: path.map((s) => s.name), bindings });
    for (const child of scope.children) walk(child, [...path, child]);
  };
  walk(root, [root]);
  return tables;
}
