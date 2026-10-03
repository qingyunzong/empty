import { RevError, E } from './errors.js';

export const TXN_STATUSES = ['SETTLED', 'PENDING', 'CANCEL_REQUESTED', 'REVERSED', 'FAILED'];

const TXN_ATTRS = {
  status: 'status',
  amount: 'money',
  id: 'string',
  locked: 'bool',
  day: 'int',
};

class Scope {
  constructor(kind, parent = null) {
    this.kind = kind; // 'global' | 'loop' | 'txn'
    this.parent = parent;
    this.vars = new Map();
  }

  declare(name, type, note) {
    if (this.vars.has(name)) {
      throw new RevError(E.TYPE, `duplicate declaration of '${name}' in ${this.kind} scope`);
    }
    this.vars.set(name, { type, note });
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.vars.has(name)) return { ...s.vars.get(name), scope: s.kind };
    }
    return null;
  }
}

const numeric = (t) => t === 'int' || t === 'money';
const comparable = (a, b) => a === b || (numeric(a) && numeric(b));

export function check(program) {
  const global = new Scope('global');
  const typeErr = (msg) => { throw new RevError(E.TYPE, msg); };

  function checkBlock(body, scope) {
    for (const stmt of body) checkStmt(stmt, scope);
  }

  function checkStmt(node, scope) {
    switch (node.kind) {
      case 'Param': {
        if (scope.kind !== 'global') {
          typeErr(`param '${node.name}' must be declared at top level (global scope)`);
        }
        scope.declare(node.name, checkExpr(node.value, scope), 'param');
        return;
      }
      case 'Let': {
        const t = checkExpr(node.expr, scope);
        const note = scope.kind === 'txn' ? 'txn-local'
          : scope.kind === 'loop' ? 'loop-temp' : 'local';
        scope.declare(node.name, t, note);
        return;
      }
      case 'For': {
        const it = checkExpr(node.iterable, scope);
        if (it !== 'list_txn') typeErr(`for loop requires a list of txns, got ${it}`);
        const loopScope = new Scope('loop', scope);
        loopScope.declare(node.varName, 'txn', 'loop-temp');
        const txnScope = new Scope('txn', loopScope);
        checkBlock(node.body, txnScope);
        return;
      }
      case 'If': {
        const c = checkExpr(node.cond, scope);
        if (c !== 'bool') typeErr(`if condition must be bool, got ${c}`);
        checkBlock(node.then, new Scope(scope.kind, scope));
        if (node.else) checkBlock(node.else, new Scope(scope.kind, scope));
        return;
      }
      case 'Reverse':
      case 'Cancel': {
        const t = checkExpr(node.target, scope);
        if (t !== 'txn') typeErr(`${node.kind.toLowerCase()} expects a txn, got ${t}`);
        return;
      }
      case 'Move': {
        const a = checkExpr(node.amount, scope);
        if (!numeric(a)) typeErr(`move amount must be money, got ${a}`);
        // from/to are account literals enforced by the grammar, so the
        // debit/credit legs of a move are always statically paired.
        return;
      }
      default:
        typeErr(`unknown statement ${node.kind}`);
    }
  }

  function checkExpr(node, scope) {
    switch (node.kind) {
      case 'Num': return node.isMoney ? 'money' : 'int';
      case 'Str': return 'string';
      case 'Bool': return 'bool';
      case 'Status': return 'status';
      case 'Txn': return 'txn';
      case 'Account': return 'account';
      case 'List': {
        for (const el of node.elements) {
          const t = checkExpr(el, scope);
          if (t !== 'txn') typeErr(`list elements must be txn references, got ${t}`);
        }
        return 'list_txn';
      }
      case 'Var': {
        const v = scope.lookup(node.name);
        if (!v) typeErr(`unknown variable '${node.name}' (line ${node.line})`);
        return v.type;
      }
      case 'Attr': {
        const o = checkExpr(node.obj, scope);
        if (o !== 'txn') typeErr(`attribute access requires a txn, got ${o}`);
        const t = TXN_ATTRS[node.name];
        if (!t) {
          typeErr(`unknown txn attribute '${node.name}' (expected one of ${Object.keys(TXN_ATTRS).join(', ')})`);
        }
        return t;
      }
      case 'Unary': {
        const t = checkExpr(node.expr, scope);
        if (node.op === 'not') {
          if (t !== 'bool') typeErr(`not expects bool, got ${t}`);
          return 'bool';
        }
        if (!numeric(t)) typeErr(`unary - expects a number, got ${t}`);
        return t;
      }
      case 'Bin': {
        const l = checkExpr(node.lhs, scope);
        const r = checkExpr(node.rhs, scope);
        for (const side of [node.lhs, node.rhs]) {
          if (side.kind === 'Status' && !TXN_STATUSES.includes(side.value)) {
            typeErr(`'${side.value}' is not a txn status (it is an entry-level flag; use txn.locked)`);
          }
        }
        switch (node.op) {
          case 'and': case 'or':
            if (l !== 'bool' || r !== 'bool') typeErr(`${node.op} expects bool operands, got ${l} and ${r}`);
            return 'bool';
          case '==': case '!=':
            if (!comparable(l, r)) typeErr(`cannot compare ${l} with ${r}`);
            return 'bool';
          case '<': case '<=': case '>': case '>=':
            if (!numeric(l) || !numeric(r)) typeErr(`ordering expects numeric operands, got ${l} and ${r}`);
            return 'bool';
          case '+': case '-':
            if (node.op === '+' && l === 'string' && r === 'string') return 'string';
            if (numeric(l) && numeric(r)) return l === 'money' || r === 'money' ? 'money' : 'int';
            typeErr(`cannot apply '${node.op}' to ${l} and ${r}`);
            break;
          case '*':
            if (l === 'int' && r === 'int') return 'int';
            if ((l === 'money' && r === 'int') || (l === 'int' && r === 'money')) return 'money';
            typeErr(`cannot multiply ${l} and ${r}`);
            break;
          default:
            typeErr(`unknown operator '${node.op}'`);
        }
        break;
      }
      default:
        typeErr(`cannot type expression ${node.kind}`);
    }
    return undefined;
  }

  checkBlock(program.body, global);
}
