'use strict';

const { DslError } = require('./errors');

const MONEY = 'money';
const RATE = 'rate';
const DATE = 'date';
const BOOL = 'bool';

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.map = new Map();
  }
  declare(name, info, line, col) {
    if (this.map.has(name)) {
      throw new DslError('E_SCOPE', `duplicate declaration of '${name}'`, line, col);
    }
    this.map.set(name, info);
  }
  lookup(name) {
    let s = this;
    while (s) {
      if (s.map.has(name)) return s.map.get(name);
      s = s.parent;
    }
    return null;
  }
}

function typeErr(msg, node) {
  throw new DslError('E_TYPE', msg, node.line, node.col);
}

function checkExpr(node, scope, ruleIdx, prog) {
  const t = visit(node, scope, ruleIdx, prog);
  node.type = t;
  return t;
}

function visit(node, scope, ruleIdx, prog) {
  switch (node.kind) {
    case 'money': return MONEY;
    case 'rate': return RATE;
    case 'date': return DATE;
    case 'bool': return BOOL;
    case 'name': {
      const info = scope.lookup(node.name);
      if (!info) {
        throw new DslError('E_SCOPE', `unbound variable '${node.name}'`, node.line, node.col);
      }
      node.resolved = info;
      return info.type;
    }
    case 'unary': {
      const t = checkExpr(node.expr, scope, ruleIdx, prog);
      if (node.op === 'not') {
        if (t !== BOOL) typeErr(`'not' requires bool, got ${t}`, node);
        return BOOL;
      }
      if (t === RATE) typeErr('negative rates are not allowed', node);
      if (t !== MONEY) typeErr(`cannot negate ${t}`, node);
      return MONEY;
    }
    case 'binary': {
      const lt = checkExpr(node.l, scope, ruleIdx, prog);
      const rt = checkExpr(node.r, scope, ruleIdx, prog);
      const op = node.op;
      if (op === 'and' || op === 'or') {
        if (lt !== BOOL || rt !== BOOL) {
          typeErr(`'${op}' requires bool operands, got ${lt} and ${rt}`, node);
        }
        return BOOL;
      }
      if (op === '==' || op === '!=') {
        if (lt !== rt) typeErr(`cannot compare ${lt} with ${rt} (no implicit conversion)`, node);
        return BOOL;
      }
      if (op === '<' || op === '<=' || op === '>' || op === '>=') {
        if (lt !== rt || (lt !== MONEY && lt !== RATE && lt !== DATE)) {
          typeErr(`cannot order ${lt} and ${rt}`, node);
        }
        return BOOL;
      }
      if (op === '+' || op === '-') {
        if (lt === rt && (lt === MONEY || lt === RATE)) return lt;
        typeErr(`cannot apply '${op}' to ${lt} and ${rt} (no implicit conversion)`, node);
      }
      if (op === '*') {
        if ((lt === MONEY && rt === RATE) || (lt === RATE && rt === MONEY)) return MONEY;
        if (lt === RATE && rt === RATE) return RATE;
        typeErr(`cannot multiply ${lt} and ${rt}`, node);
      }
      typeErr(`unknown operator '${op}'`, node);
      break;
    }
    case 'if': {
      const ct = checkExpr(node.cond, scope, ruleIdx, prog);
      if (ct !== BOOL) typeErr(`if condition must be bool, got ${ct}`, node.cond);
      const a = checkExpr(node.then, scope, ruleIdx, prog);
      const b = checkExpr(node.else, scope, ruleIdx, prog);
      if (a !== b) typeErr(`if branches have different types: ${a} and ${b}`, node);
      return a;
    }
    case 'call': {
      if (node.name === 'round') {
        if (node.args.length !== 1) typeErr('round() takes exactly 1 argument', node);
        const at = checkExpr(node.args[0], scope, ruleIdx, prog);
        if (at !== MONEY) typeErr(`round() expects money, got ${at}`, node);
        return MONEY;
      }
      const idx = ruleIdx.get(node.name);
      if (idx === undefined) {
        throw new DslError('E_SCOPE', `unknown rule '${node.name}'`, node.line, node.col);
      }
      node.ruleIdx = idx;
      const sig = prog.rules[idx];
      if (node.args.length !== sig.params.length) {
        typeErr(`rule '${node.name}' expects ${sig.params.length} argument(s), got ${node.args.length}`, node);
      }
      node.args.forEach((arg, i) => {
        const at = checkExpr(arg, scope, ruleIdx, prog);
        if (at !== sig.params[i].type) {
          typeErr(`argument ${i + 1} of rule '${node.name}' must be ${sig.params[i].type}, got ${at}`, arg);
        }
      });
      return sig.retType;
    }
    default:
      throw new DslError('E_TYPE', `internal: unknown node kind '${node.kind}'`, node.line, node.col);
  }
}

function check(prog) {
  const global = new Scope();
  const ruleIdx = new Map();
  prog.rules.forEach((r, i) => {
    if (ruleIdx.has(r.name)) {
      throw new DslError('E_SCOPE', `duplicate rule '${r.name}'`, r.line, r.col);
    }
    ruleIdx.set(r.name, i);
  });
  prog.lets.forEach((l, i) => {
    const t = checkExpr(l.expr, global, ruleIdx, prog);
    if (t !== l.type) {
      throw new DslError('E_TYPE', `let '${l.name}' declared as ${l.type} but initialized with ${t}`, l.line, l.col);
    }
    global.declare(l.name, { type: l.type, space: 'g', slot: i }, l.line, l.col);
  });
  prog.rules.forEach((r) => {
    const scope = new Scope(global);
    r.params.forEach((p, i) => {
      scope.declare(p.name, { type: p.type, space: 'l', slot: i }, p.line, p.col);
    });
    r.lets.forEach((l, i) => {
      const t = checkExpr(l.expr, scope, ruleIdx, prog);
      if (t !== l.type) {
        throw new DslError('E_TYPE', `let '${l.name}' declared as ${l.type} but initialized with ${t}`, l.line, l.col);
      }
      scope.declare(l.name, { type: l.type, space: 'l', slot: r.params.length + i }, l.line, l.col);
    });
    const rt = checkExpr(r.ret, scope, ruleIdx, prog);
    if (rt !== r.retType) {
      throw new DslError('E_TYPE', `rule '${r.name}' returns ${rt} but is declared -> ${r.retType}`, r.line, r.col);
    }
  });
  return prog;
}

module.exports = { check };
