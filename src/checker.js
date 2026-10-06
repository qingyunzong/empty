import { TypeCheckError } from './errors.js';

// Static types: 'quantity' | 'ratio' | 'defect_level' | 'boolean'
export const LEVEL_ORDER = { none: 0, minor: 1, major: 2, critical: 3 };

const BUILTINS = {
  floor: { args: ['quantity'], ret: 'quantity' },
  ceil: { args: ['quantity'], ret: 'quantity' },
  abs: { args: ['quantity'], ret: 'quantity' },
  min: { args: ['quantity', 'quantity'], ret: 'quantity' },
  max: { args: ['quantity', 'quantity'], ret: 'quantity' },
};

// Lexical scope chain: each scope is a Map name -> { type, slot }.
class Scope {
  constructor(parent = null, alloc = null) {
    this.parent = parent;
    this.bindings = new Map();
    this.alloc = alloc; // shared slot allocator
  }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.bindings.has(name)) return s.bindings.get(name);
    }
    return null;
  }
  define(name, type, line) {
    if (this.bindings.has(name)) {
      throw new TypeCheckError(`duplicate definition of '${name}' in the same scope`, { line });
    }
    const slot = this.alloc.next++;
    this.bindings.set(name, { type, slot });
    return slot;
  }
}

function arithResult(op, lt, rt, line) {
  const num = (t) => t === 'quantity' || t === 'ratio';
  if (!num(lt) || !num(rt)) {
    throw new TypeCheckError(`operator '${op}' requires numeric operands, got ${lt} and ${rt}`, { line });
  }
  if (op === '+' || op === '-') {
    if (lt !== rt) throw new TypeCheckError(`operator '${op}' requires matching types, got ${lt} and ${rt}`, { line });
    return lt;
  }
  if (op === '*') {
    if (lt === 'ratio' && rt === 'ratio') return 'ratio';
    if (lt === 'ratio' || rt === 'ratio') return 'quantity';
    return 'quantity';
  }
  // '/': quantity/quantity is a defect ratio; quantity/ratio scales back up.
  if (lt === 'quantity' && rt === 'quantity') return 'ratio';
  if (lt === 'quantity' && rt === 'ratio') return 'quantity';
  if (lt === 'ratio' && rt === 'ratio') return 'ratio';
  throw new TypeCheckError(`operator '/' does not accept ${lt} / ${rt}`, { line });
}

function checkExpr(node, scope) {
  switch (node.kind) {
    case 'num':
      node.type = 'quantity';
      return node.type;
    case 'percent':
      node.type = 'ratio';
      return node.type;
    case 'level':
      node.type = 'defect_level';
      return node.type;
    case 'str':
      throw new TypeCheckError('string literals are not allowed in expressions', { line: node.line });
    case 'ident': {
      const b = scope.lookup(node.name);
      if (!b) throw new TypeCheckError(`undefined name '${node.name}'`, { line: node.line });
      node.slot = b.slot;
      node.type = b.type;
      return node.type;
    }
    case 'call': {
      const sig = BUILTINS[node.name];
      if (!sig) throw new TypeCheckError(`unknown function '${node.name}'`, { line: node.line });
      if (node.args.length !== sig.args.length) {
        throw new TypeCheckError(`function '${node.name}' expects ${sig.args.length} argument(s), got ${node.args.length}`, { line: node.line });
      }
      node.args.forEach((arg, idx) => {
        const at = checkExpr(arg, scope);
        if (at !== sig.args[idx]) {
          throw new TypeCheckError(`function '${node.name}' argument ${idx + 1} must be ${sig.args[idx]}, got ${at}`, { line: arg.line });
        }
      });
      node.type = sig.ret;
      return node.type;
    }
    case 'neg': {
      const t = checkExpr(node.expr, scope);
      if (t !== 'quantity' && t !== 'ratio') {
        throw new TypeCheckError(`unary '-' requires a numeric operand, got ${t}`, { line: node.line });
      }
      node.type = t;
      return t;
    }
    case 'not': {
      const t = checkExpr(node.expr, scope);
      if (t !== 'boolean') throw new TypeCheckError(`'not' requires a boolean operand, got ${t}`, { line: node.line });
      node.type = 'boolean';
      return node.type;
    }
    case 'bin': {
      const lt = checkExpr(node.left, scope);
      const rt = checkExpr(node.right, scope);
      const op = node.op;
      if (op === 'and' || op === 'or') {
        if (lt !== 'boolean' || rt !== 'boolean') {
          throw new TypeCheckError(`'${op}' requires boolean operands, got ${lt} and ${rt}`, { line: node.line });
        }
        node.type = 'boolean';
        return node.type;
      }
      if (op === '==' || op === '!=') {
        if (lt !== rt) throw new TypeCheckError(`cannot compare ${lt} with ${rt} using '${op}'`, { line: node.line });
        node.type = 'boolean';
        return node.type;
      }
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (lt !== rt) throw new TypeCheckError(`cannot compare ${lt} with ${rt} using '${op}'`, { line: node.line });
        if (lt === 'boolean') throw new TypeCheckError(`operator '${op}' does not accept boolean operands`, { line: node.line });
        node.type = 'boolean';
        return node.type;
      }
      node.type = arithResult(op, lt, rt, node.line);
      return node.type;
    }
    default:
      throw new TypeCheckError(`internal: unknown expression kind '${node.kind}'`, { line: node.line });
  }
}

function checkLet(stmt, scope) {
  const t = checkExpr(stmt.expr, scope);
  if (t !== stmt.type) {
    throw new TypeCheckError(`let '${stmt.name}' declared as ${stmt.type} but expression has type ${t}`, { line: stmt.line });
  }
  stmt.slot = scope.alloc.next++;
}

// Annotates the AST in place (identifier slots, expression types).
// Returns { params: [{name,type,slot}], slots } for the compiler/VM.
export function check(rule) {
  const alloc = { next: 0 };
  const globalScope = new Scope(null, alloc);
  const params = [];
  for (const p of rule.params) {
    p.slot = globalScope.define(p.name, p.type, p.line);
    params.push({ name: p.name, type: p.type, slot: p.slot });
  }
  // Each let opens a fresh lexical layer, so a later binding shadows an
  // earlier one while earlier expressions keep their original resolution.
  let scope = globalScope;
  for (const stmt of rule.lets) {
    checkLet(stmt, scope);
    scope = new Scope(scope, alloc);
    scope.bindings.set(stmt.name, { type: stmt.type, slot: stmt.slot });
  }

  // decide block opens a nested lexical scope; its lets do not leak out.
  let decideScope = new Scope(scope, alloc);
  for (const stmt of rule.decide.lets) {
    checkLet(stmt, decideScope);
    const next = new Scope(decideScope, alloc);
    next.bindings.set(stmt.name, { type: stmt.type, slot: stmt.slot });
    decideScope = next;
  }
  for (const w of rule.decide.whens) {
    const t = checkExpr(w.guard, decideScope);
    if (t !== 'boolean') {
      throw new TypeCheckError(`when guard must be boolean, got ${t}`, { line: w.line });
    }
  }
  return { params, slots: alloc.next };
}
