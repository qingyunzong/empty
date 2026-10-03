// Compiles the typed DSL AST into executable rule objects. let bindings are
// constant-folded at compile time by running their bytecode in the VM;
// constraint when-expressions compile to bytecode evaluated per event pair.

import { DslError } from './lexer.js';
import { run } from './vm.js';

const BIN_OP = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD',
  '==': 'EQ', '!=': 'NE', '<': 'LT', '<=': 'LE', '>': 'GT', '>=': 'GE',
};
const EVENT_OP = { 'happens-before': 'HB', concurrent: 'CONC', commutes: 'COMM' };

function compileError(msg, line) {
  throw new DslError(msg, line, 0);
}

function containsCommutesCall(e) {
  if (!e || typeof e !== 'object') return false;
  if (e.t === 'call' && e.name === 'commutes') return true;
  if (e.t === 'bin' && e.op === 'commutes') return true;
  return Object.values(e).some((v) => {
    if (Array.isArray(v)) return v.some(containsCommutesCall);
    return v && typeof v === 'object' && containsCommutesCall(v);
  });
}

// env: (name) => {const: value} | {slot: n} | undefined
function genExpr(e, env, code) {
  switch (e.t) {
    case 'num': case 'str': case 'bool': code.push(['PUSH', e.v]); return;
    case 'null': code.push(['PUSH', null]); return;
    case 'var': {
      const b = env(e.name);
      if (!b) compileError(`unresolved variable "${e.name}"`, e.line);
      if ('const' in b) code.push(['PUSH', b.const]);
      else code.push(['LOAD', b.slot]);
      return;
    }
    case 'field':
      genExpr(e.obj, env, code);
      code.push(['FIELD', e.name]);
      return;
    case 'un':
      genExpr(e.e, env, code);
      code.push([e.op === 'not' ? 'NOT' : 'NEG']);
      return;
    case 'match':
      genExpr(e.l, env, code);
      code.push(['RE', e.source, '']);
      return;
    case 'call': {
      const op = EVENT_OP[e.name];
      if (!op) compileError(`unknown builtin "${e.name}"`, e.line);
      genExpr(e.args[0], env, code);
      genExpr(e.args[1], env, code);
      code.push([op]);
      return;
    }
    case 'bin': {
      if (e.op === 'and') {
        genExpr(e.l, env, code);
        const jFalse = code.length; code.push(null);
        genExpr(e.r, env, code);
        const jEnd = code.length; code.push(null);
        code[jFalse] = ['JIF', code.length];
        code.push(['PUSH', false]);
        code[jEnd] = ['JMP', code.length];
        return;
      }
      if (e.op === 'or') {
        genExpr(e.l, env, code);
        const jRhs = code.length; code.push(null);
        code.push(['PUSH', true]);
        const jEnd = code.length; code.push(null);
        code[jRhs] = ['JIF', code.length];
        genExpr(e.r, env, code);
        code[jEnd] = ['JMP', code.length];
        return;
      }
      if (e.op in EVENT_OP) {
        genExpr(e.l, env, code);
        genExpr(e.r, env, code);
        code.push([EVENT_OP[e.op]]);
        return;
      }
      const op = BIN_OP[e.op];
      if (!op) compileError(`cannot compile operator "${e.op}"`, e.line);
      genExpr(e.l, env, code);
      genExpr(e.r, env, code);
      code.push([op]);
      return;
    }
    default:
      compileError(`cannot compile expression node "${e.t}"`, e.line);
  }
}

function compileExpr(e, env) {
  const code = [];
  genExpr(e, env, code);
  code.push(['END']);
  return code;
}

function compilePattern(pat, ops, slots) {
  const decl = ops.get(pat.op);
  const args = pat.args.map((arg, i) => {
    const field = decl.params[i].name;
    switch (arg.t) {
      case 'wild': return { t: 'wild', field };
      case 'lit': return { t: 'lit', field, v: arg.v };
      case 'regex': return { t: 'regex', field, re: new RegExp(arg.source) };
      case 'var': {
        if (!slots.has(arg.name)) slots.set(arg.name, slots.size);
        return { t: 'var', field, slot: slots.get(arg.name) };
      }
      default: compileError(`bad pattern argument "${arg.t}"`, pat.line);
    }
  });
  return { op: pat.op, args };
}

export function compileProgram(ast, ops) {
  const effects = {};
  for (const [name, decl] of ops) {
    if (decl.effect && decl.effect.kind === 'sets') {
      effects[name] = { kind: 'sets', keyField: decl.effect.keyParam, valueField: decl.effect.valueParam };
    } else if (decl.effect && decl.effect.kind === 'gets') {
      effects[name] = { kind: 'gets', keyField: decl.effect.keyParam };
    } else {
      effects[name] = { kind: 'none' };
    }
  }

  const constraints = [];

  for (const decl of ast.decls) {
    if (decl.t !== 'rule') continue;
    // Lexically scoped let bindings, constant-folded at compile time.
    const scopeStack = [new Map()];
    const lookupLet = (name) => {
      for (let i = scopeStack.length - 1; i >= 0; i--) {
        if (scopeStack[i].has(name)) return { const: scopeStack[i].get(name) };
      }
      return undefined;
    };
    const walk = (block) => {
      scopeStack.push(new Map());
      for (const stmt of block.stmts) {
        if (stmt.t === 'let') {
          const code = compileExpr(stmt.expr, lookupLet);
          scopeStack[scopeStack.length - 1].set(stmt.name, run(code, { slots: [] }));
        } else if (stmt.t === 'block') {
          walk(stmt);
        } else if (stmt.t === 'constraint') {
          constraints.push(compileConstraint(stmt, ops, lookupLet));
        }
      }
      scopeStack.pop();
    };
    walk(decl.body);
  }

  return { effects, constraints, ops };
}

function compileConstraint(stmt, ops, lookupLet) {
  if (stmt.kind === 'commutes' && stmt.when && containsCommutesCall(stmt.when)) {
    compileError('a commutes constraint may not use the commutes builtin in its when-expression', stmt.line);
  }
  // Slots 0 and 1 are the matched events a and b; pattern variables follow.
  const slots = new Map([['a', 0], ['b', 1]]);
  const patA = compilePattern(stmt.patA, ops, slots);
  const patB = compilePattern(stmt.patB, ops, slots);
  let when = null;
  if (stmt.when) {
    const env = (name) => {
      if (slots.has(name)) return { slot: slots.get(name) };
      return lookupLet(name);
    };
    when = compileExpr(stmt.when, env);
  }
  return {
    kind: stmt.kind,
    patA,
    patB,
    when,
    numSlots: slots.size,
    line: stmt.line,
  };
}
