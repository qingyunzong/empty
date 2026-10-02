import { typeError, scopeError, stateError } from './errors.js';

export const TERMINAL_STATUSES = new Set(['REVERSED', 'CANCEL_REQUESTED', 'COMPENSATED']);

const FIELD_TYPES = {
  status: 'Status',
  amount: 'Amount',
  account: 'Acct',
  day: 'Number',
  id: 'String',
};

class Scope {
  constructor(kind, parent = null) {
    this.kind = kind;
    this.parent = parent;
    this.vars = new Map();
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.vars.has(name)) return s.vars.get(name);
    }
    return undefined;
  }
}

export function check(plan) {
  const params = new Map();
  for (const p of plan.params) {
    if (params.has(p.name)) throw scopeError(`duplicate param '${p.name}'`, p);
    params.set(p.name, evalConst(p.value, params, p));
  }
  const global = new Scope('global');
  for (const [name, v] of params) global.vars.set(name, v.t);
  checkBlock(plan.body, global, { params, guards: new Map() });
  return { params };
}

function checkBlock(stmts, scope, ctx) {
  for (const s of stmts) checkStmt(s, scope, ctx);
}

function checkStmt(s, scope, ctx) {
  switch (s.kind) {
    case 'Let': {
      if (scope.kind === 'global') {
        throw scopeError("'let' is only allowed inside a loop or txn scope; use 'param' for globals", s);
      }
      const t = checkExpr(s.expr, scope, ctx);
      if (scope.vars.has(s.name)) throw scopeError(`duplicate local '${s.name}'`, s);
      scope.vars.set(s.name, t);
      return;
    }
    case 'Revoke': {
      const t = checkExpr(s.expr, scope, ctx);
      if (t !== 'Txn') throw typeError(`revoke expects a txn operand, got ${t}`, s);
      if (s.expr.kind === 'Ident') {
        const guarded = ctx.guards.get(s.expr.name);
        if (guarded) {
          for (const st of guarded) {
            if (TERMINAL_STATUSES.has(st)) {
              throw stateError(
                `illegal transition: '${s.expr.name}' is guarded by terminal status ${st} and can never be revoked`,
                s,
              );
            }
          }
        }
      }
      return;
    }
    case 'When': {
      const ct = checkExpr(s.cond, scope, ctx);
      if (ct !== 'Bool') throw typeError(`when condition must be Bool, got ${ct}`, s);
      const guards = mergeGuards(ctx.guards, extractGuards(s.cond));
      const child = new Scope(scope.kind === 'global' ? 'global' : 'txn', scope);
      checkBlock(s.body, child, { ...ctx, guards });
      return;
    }
    case 'For': {
      if (scope.lookup(s.name) !== undefined) {
        throw scopeError(`loop variable '${s.name}' shadows an outer binding`, s);
      }
      const loopScope = new Scope('loop', scope);
      loopScope.vars.set(s.name, 'Txn');
      const txnScope = new Scope('txn', loopScope);
      checkBlock(s.body, txnScope, ctx);
      return;
    }
    default:
      throw scopeError(`unknown statement kind ${s.kind}`, s);
  }
}

function checkExpr(e, scope, ctx) {
  switch (e.kind) {
    case 'Number': return 'Number';
    case 'Amount': return 'Amount';
    case 'String': return 'String';
    case 'Bool': return 'Bool';
    case 'Status': return 'Status';
    case 'Txn': return 'Txn';
    case 'Acct': return 'Acct';
    case 'Ident': {
      const t = scope.lookup(e.name);
      if (t === undefined) throw scopeError(`undefined name '${e.name}'`, e);
      return t;
    }
    case 'Field': {
      const ot = checkExpr(e.obj, scope, ctx);
      if (ot !== 'Txn') throw typeError(`field access requires a txn, got ${ot}`, e);
      const ft = FIELD_TYPES[e.name];
      if (!ft) throw typeError(`unknown txn field '${e.name}'`, e);
      return ft;
    }
    case 'Unary': {
      const t = checkExpr(e.expr, scope, ctx);
      if (e.op === 'not') {
        if (t !== 'Bool') throw typeError(`'not' expects Bool, got ${t}`, e);
        return 'Bool';
      }
      if (t !== 'Number' && t !== 'Amount') throw typeError(`unary '-' expects Number or Amount, got ${t}`, e);
      return t;
    }
    case 'Binary': {
      const lt = checkExpr(e.left, scope, ctx);
      const rt = checkExpr(e.right, scope, ctx);
      return binaryType(e.op, lt, rt, e);
    }
    default:
      throw typeError(`unknown expression kind ${e.kind}`, e);
  }
}

function binaryType(op, lt, rt, node) {
  switch (op) {
    case 'and':
    case 'or':
      if (lt === 'Bool' && rt === 'Bool') return 'Bool';
      break;
    case '==':
    case '!=':
      if (lt === rt) return 'Bool';
      break;
    case '<':
    case '<=':
    case '>':
    case '>=':
      if ((lt === 'Number' && rt === 'Number') || (lt === 'Amount' && rt === 'Amount')) return 'Bool';
      break;
    case '+':
      if (lt === 'Number' && rt === 'Number') return 'Number';
      if (lt === 'Amount' && rt === 'Amount') return 'Amount';
      if (lt === 'String' && rt === 'String') return 'String';
      break;
    case '-':
      if (lt === 'Number' && rt === 'Number') return 'Number';
      if (lt === 'Amount' && rt === 'Amount') return 'Amount';
      break;
    case '*':
      if (lt === 'Number' && rt === 'Number') return 'Number';
      if (lt === 'Amount' && rt === 'Number') return 'Amount';
      if (lt === 'Number' && rt === 'Amount') return 'Amount';
      break;
    case '/':
      if (lt === 'Number' && rt === 'Number') return 'Number';
      if (lt === 'Amount' && rt === 'Number') return 'Amount';
      break;
    default:
      break;
  }
  throw typeError(`invalid operand types for '${op}': ${lt} and ${rt}`, node);
}

function evalConst(e, params, node) {
  switch (e.kind) {
    case 'Number': return { t: 'Number', v: e.value };
    case 'Amount': return { t: 'Amount', v: e.value };
    case 'String': return { t: 'String', v: e.value };
    case 'Bool': return { t: 'Bool', v: e.value };
    case 'Status': return { t: 'Status', v: e.value };
    case 'Txn': return { t: 'Txn', v: e.value };
    case 'Acct': return { t: 'Acct', v: e.value };
    case 'Ident': {
      const v = params.get(e.name);
      if (!v) throw scopeError(`param initializer must be constant; unknown name '${e.name}'`, node);
      return v;
    }
    case 'Unary': {
      const v = evalConst(e.expr, params, node);
      if (e.op === 'not') {
        if (v.t !== 'Bool') throw typeError(`'not' expects Bool, got ${v.t}`, node);
        return { t: 'Bool', v: !v.v };
      }
      if (v.t !== 'Number' && v.t !== 'Amount') throw typeError(`unary '-' expects Number or Amount`, node);
      return { t: v.t, v: -v.v };
    }
    case 'Binary': {
      const l = evalConst(e.left, params, node);
      const r = evalConst(e.right, params, node);
      binaryType(e.op, l.t, r.t, node);
      return { t: binaryType(e.op, l.t, r.t, node), v: evalBinary(e.op, l, r) };
    }
    default:
      throw typeError('param initializer must be a constant expression', node);
  }
}

export function evalBinary(op, l, r) {
  switch (op) {
    case 'and': return l.v && r.v;
    case 'or': return l.v || r.v;
    case '==': return l.t === r.t && l.v === r.v;
    case '!=': return !(l.t === r.t && l.v === r.v);
    case '<': return l.v < r.v;
    case '<=': return l.v <= r.v;
    case '>': return l.v > r.v;
    case '>=': return l.v >= r.v;
    case '+': return l.v + r.v;
    case '-': return l.v - r.v;
    case '*': return l.v * r.v;
    case '/': return Math.trunc(l.v / r.v);
    default: throw new Error(`unknown operator ${op}`);
  }
}

function extractGuards(cond, out = new Map()) {
  if (cond.kind === 'Binary' && cond.op === 'and') {
    extractGuards(cond.left, out);
    extractGuards(cond.right, out);
  } else if (cond.kind === 'Binary' && cond.op === '==') {
    const sides = [cond.left, cond.right];
    for (let k = 0; k < 2; k += 1) {
      const f = sides[k];
      const other = sides[1 - k];
      if (
        f.kind === 'Field' && f.name === 'status' && f.obj.kind === 'Ident'
        && other.kind === 'Status'
      ) {
        if (!out.has(f.obj.name)) out.set(f.obj.name, new Set());
        out.get(f.obj.name).add(other.value);
      }
    }
  }
  return out;
}

function mergeGuards(base, extra) {
  const out = new Map();
  for (const [k, v] of base) out.set(k, new Set(v));
  for (const [k, v] of extra) {
    if (!out.has(k)) out.set(k, new Set());
    for (const s of v) out.get(k).add(s);
  }
  return out;
}
