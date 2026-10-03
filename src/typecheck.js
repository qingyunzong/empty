// Static type checker for the rule DSL. Checks operation declarations,
// pattern arguments against declared parameter types, and when-expressions
// against lexically scoped let bindings. Rule blocks are lexically scoped:
// inner blocks may shadow outer lets.

import { DslError } from './lexer.js';

export const EVENT_FIELDS = {
  id: 'string',
  node: 'string',
  op: 'string',
  key: 'string',
  value: 'any',
  invocation: 'int',
  response: 'int',
  realTime: 'int',
};

function tcError(msg, line) {
  throw new DslError(msg, line, 0);
}

function typeName(t) {
  return t;
}

// Is a value of type `from` assignable to a slot of type `to`?
function assignable(from, to) {
  if (to === 'any' || from === 'any') return true;
  if (from === to) return true;
  if (from === 'null') return to === 'any';
  return false;
}

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();
  }
  lookup(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent ? this.parent.lookup(name) : undefined;
  }
}

export function typecheck(ast) {
  const ops = new Map();

  for (const decl of ast.decls) {
    if (decl.t !== 'opDecl') continue;
    if (ops.has(decl.name)) tcError(`duplicate operation "${decl.name}"`, decl.line);
    const seen = new Set();
    for (const p of decl.params) {
      if (seen.has(p.name)) tcError(`duplicate parameter "${p.name}" in op "${decl.name}"`, decl.line);
      seen.add(p.name);
    }
    if (decl.effect) {
      const names = new Set(decl.params.map((p) => p.name));
      const need = decl.effect.kind === 'sets'
        ? [decl.effect.keyParam, decl.effect.valueParam]
        : [decl.effect.keyParam];
      for (const n of need) {
        if (!names.has(n)) tcError(`effect of op "${decl.name}" refers to undeclared parameter "${n}"`, decl.line);
      }
      const keyParam = decl.params.find((p) => p.name === decl.effect.keyParam);
      if (!assignable('string', keyParam.type) && keyParam.type !== 'string') {
        tcError(`key parameter "${keyParam.name}" of op "${decl.name}" must be string-typed`, decl.line);
      }
    }
    ops.set(decl.name, { params: decl.params, ret: decl.ret, effect: decl.effect, line: decl.line });
  }

  for (const decl of ast.decls) {
    if (decl.t !== 'rule') continue;
    checkBlock(decl.body, new Scope(null), ops);
  }

  return { ops };
}

function checkBlock(block, scope, ops) {
  const inner = new Scope(scope);
  for (const stmt of block.stmts) {
    if (stmt.t === 'let') {
      const ty = typeOf(stmt.expr, inner, ops);
      inner.vars.set(stmt.name, ty);
    } else if (stmt.t === 'block') {
      checkBlock(stmt, inner, ops);
    } else if (stmt.t === 'constraint') {
      checkConstraint(stmt, inner, ops);
    }
  }
}

function checkConstraint(stmt, scope, ops) {
  const cScope = new Scope(scope);
  cScope.vars.set('a', 'event');
  cScope.vars.set('b', 'event');
  bindPattern(stmt.patA, cScope, ops, stmt.line);
  bindPattern(stmt.patB, cScope, ops, stmt.line);
  if (stmt.when) {
    const ty = typeOf(stmt.when, cScope, ops);
    if (ty !== 'bool' && ty !== 'any') {
      tcError(`when-expression of ${stmt.kind} constraint must be bool, got ${typeName(ty)}`, stmt.line);
    }
  }
}

function bindPattern(pat, scope, ops, line) {
  const decl = ops.get(pat.op);
  if (!decl) tcError(`pattern refers to undeclared op "${pat.op}"`, pat.line);
  if (pat.args.length !== decl.params.length) {
    tcError(`op "${pat.op}" takes ${decl.params.length} argument(s) but pattern has ${pat.args.length}`, pat.line);
  }
  pat.args.forEach((arg, i) => {
    const param = decl.params[i];
    if (!(param.name in EVENT_FIELDS)) {
      tcError(`parameter "${param.name}" of op "${pat.op}" does not name an event field (use key/value/...)`, pat.line);
    }
    if (arg.t === 'wild') return;
    if (arg.t === 'var') {
      if (!scope.vars.has(arg.name)) scope.vars.set(arg.name, param.type);
      return;
    }
    if (arg.t === 'regex') {
      if (param.type !== 'string' && param.type !== 'any') {
        tcError(`regex pattern cannot match ${param.type} parameter "${param.name}" of op "${pat.op}"`, arg.line);
      }
      return;
    }
    // literal
    const litType = arg.v === null ? 'null' : typeof arg.v === 'number' ? 'int' : typeof arg.v === 'string' ? 'string' : 'bool';
    if (!assignable(litType, param.type)) {
      tcError(`literal of type ${litType} does not match ${param.type} parameter "${param.name}" of op "${pat.op}"`, arg.line);
    }
  });
}

function typeOf(e, scope, ops) {
  switch (e.t) {
    case 'num': return 'int';
    case 'str': return 'string';
    case 'bool': return 'bool';
    case 'null': return 'null';
    case 'var': {
      const ty = scope.lookup(e.name);
      if (ty === undefined) tcError(`undefined variable "${e.name}"`, e.line);
      return ty;
    }
    case 'field': {
      const ot = typeOf(e.obj, scope, ops);
      if (ot !== 'event' && ot !== 'any') tcError(`field access on non-event value of type ${ot}`, e.line);
      const ft = EVENT_FIELDS[e.name];
      if (!ft) tcError(`unknown event field "${e.name}"`, e.line);
      return ft;
    }
    case 'un': {
      const ty = typeOf(e.e, scope, ops);
      if (e.op === 'not') {
        if (ty !== 'bool' && ty !== 'any') tcError(`"not" expects bool, got ${ty}`, e.line);
        return 'bool';
      }
      if (ty !== 'int' && ty !== 'any') tcError(`unary "-" expects int, got ${ty}`, e.line);
      return 'int';
    }
    case 'match': {
      const lt = typeOf(e.l, scope, ops);
      if (lt !== 'string' && lt !== 'any') tcError(`"=~" expects a string left operand, got ${lt}`, e.line);
      return 'bool';
    }
    case 'call': {
      if (e.args.length !== 2) tcError(`"${e.name}" expects exactly 2 arguments`, e.line);
      for (const a of e.args) {
        const at = typeOf(a, scope, ops);
        if (at !== 'event' && at !== 'any') tcError(`"${e.name}" expects event arguments, got ${at}`, a.line);
      }
      return 'bool';
    }
    case 'bin': {
      const lt = typeOf(e.l, scope, ops);
      const rt = typeOf(e.r, scope, ops);
      switch (e.op) {
        case 'and': case 'or':
          if (lt !== 'bool' && lt !== 'any') tcError(`"${e.op}" expects bool operands, got ${lt}`, e.line);
          if (rt !== 'bool' && rt !== 'any') tcError(`"${e.op}" expects bool operands, got ${rt}`, e.line);
          return 'bool';
        case '+': case '-': case '*': case '/': case '%':
          if (lt !== 'int' && lt !== 'any') tcError(`"${e.op}" expects int operands, got ${lt}`, e.line);
          if (rt !== 'int' && rt !== 'any') tcError(`"${e.op}" expects int operands, got ${rt}`, e.line);
          return 'int';
        case '<': case '<=': case '>': case '>=':
          if (lt !== 'int' && lt !== 'string' && lt !== 'any') tcError(`"${e.op}" cannot compare ${lt}`, e.line);
          return 'bool';
        case '==': case '!=':
          return 'bool';
        case 'happens-before': case 'concurrent': case 'commutes':
          if (lt !== 'event' && lt !== 'any') tcError(`"${e.op}" expects event operands, got ${lt}`, e.line);
          if (rt !== 'event' && rt !== 'any') tcError(`"${e.op}" expects event operands, got ${rt}`, e.line);
          return 'bool';
        default:
          tcError(`unknown operator "${e.op}"`, e.line);
      }
    }
  }
  tcError(`cannot type expression node "${e.t}"`, e.line);
}
