import { NetError, E } from './errors.js';

// Static types:
//   'int' | 'bps' | 'bool' | 'ccy' | 'member' | 'obid' | 'date'
//   { m: 'money', ccy: string|null, kind: 'gross'|'net'|'any' }
// ccy=null means "currency not statically known" (e.g. the `amount` field);
// it unifies with any concrete currency, and the VM re-checks at runtime.
const MONEY = (ccy, kind) => ({ m: 'money', ccy, kind });
const isMoney = (t) => typeof t === 'object' && t !== null && t.m === 'money';

const FILTER_FIELDS = {
  amount: MONEY(null, 'gross'),
  ccy: 'ccy', debtor: 'member', creditor: 'member', id: 'obid', day: 'date',
};
const SETTLE_FIELDS = {
  position: MONEY(null, 'net'),
  member: 'member', ccy: 'ccy', day: 'date',
};

function fmt(t) {
  if (isMoney(t)) return `money<${t.ccy || '?'},${t.kind}>`;
  return String(t);
}

function unifyMoney(a, b, line) {
  if (a === 'int' && isMoney(b)) return b; // bare integer promotes to money of unknown ccy
  if (b === 'int' && isMoney(a)) return a;
  if (!isMoney(a) || !isMoney(b)) {
    throw new NetError(E.TYPE, `cannot combine ${fmt(a)} with ${fmt(b)} at line ${line}`);
  }
  if (a.ccy && b.ccy && a.ccy !== b.ccy) {
    throw new NetError(E.CCY, `cannot combine ${a.ccy} with ${b.ccy} at line ${line}`);
  }
  if (a.kind !== 'any' && b.kind !== 'any' && a.kind !== b.kind) {
    throw new NetError(E.TYPE, `cannot treat a ${a.kind} amount as ${b.kind} at line ${line}`);
  }
  return MONEY(a.ccy || b.ccy, a.kind !== 'any' ? a.kind : b.kind);
}

function checkExpr(n, ctx) {
  switch (n.t) {
    case 'int': return 'int';
    case 'bps': return 'bps';
    case 'bool': return 'bool';
    case 'ccy': return 'ccy';
    case 'member': return 'member';
    case 'obid': return 'obid';
    case 'date': return 'date';
    case 'money': return MONEY(n.ccy, 'any');
    case 'ident': {
      if (ctx.consts.has(n.name)) return ctx.consts.get(n.name).type;
      const fields = ctx.scope === 'filter' ? FILTER_FIELDS
        : ctx.scope === 'settle' ? SETTLE_FIELDS : {};
      if (fields[n.name]) return fields[n.name];
      if (n.name === 'position' && ctx.scope === 'filter') {
        throw new NetError(E.TYPE,
          `net position cannot be used as a gross amount in a filter at line ${n.line}`);
      }
      if (n.name === 'amount' && ctx.scope === 'settle') {
        throw new NetError(E.TYPE,
          `gross amount cannot be used as a net position in a settle expression at line ${n.line}`);
      }
      if (FILTER_FIELDS[n.name] || SETTLE_FIELDS[n.name]) {
        throw new NetError(E.TYPE,
          `field '${n.name}' is not available in a const context at line ${n.line}`);
      }
      throw new NetError(E.PARSE, `unknown identifier '${n.name}' at line ${n.line}`);
    }
    case 'crossref':
      throw new NetError(E.SCOPE,
        `cross-date constant reference '${n.date}.${n.name}' is forbidden at line ${n.line}`);
    case 'un': {
      const t = checkExpr(n.e, ctx);
      if (n.op === 'not') {
        if (t !== 'bool') throw new NetError(E.TYPE, `not expects bool, got ${fmt(t)} at line ${n.line}`);
        return 'bool';
      }
      if (t === 'int' || t === 'bps' || isMoney(t)) return t;
      throw new NetError(E.TYPE, `cannot negate ${fmt(t)} at line ${n.line}`);
    }
    case 'bin': {
      const lt = checkExpr(n.l, ctx);
      const rt = checkExpr(n.r, ctx);
      switch (n.op) {
        case 'PLUS': case 'MINUS': {
          if (lt === 'int' && rt === 'int') return 'int';
          if (lt === 'bps' && rt === 'bps') return 'bps';
          if ((isMoney(lt) || lt === 'int') && (isMoney(rt) || rt === 'int')) {
            return unifyMoney(lt, rt, n.line);
          }
          break;
        }
        case 'STAR': {
          if (lt === 'int' && rt === 'int') return 'int';
          if ((lt === 'int' && rt === 'bps') || (lt === 'bps' && rt === 'int')) return 'int';
          if (isMoney(lt) && rt === 'bps') return lt;
          if (lt === 'bps' && isMoney(rt)) return rt;
          break;
        }
        case 'EQ': case 'NE': {
          if (isMoney(lt) || isMoney(rt)) {
            if ((isMoney(lt) || lt === 'int') && (isMoney(rt) || rt === 'int')) {
              unifyMoney(lt, rt, n.line);
              return 'bool';
            }
            break;
          }
          if (lt === rt) return 'bool';
          break;
        }
        case 'LT': case 'LE': case 'GT': case 'GE': {
          if (lt === rt && (lt === 'int' || lt === 'bps' || lt === 'date')) return 'bool';
          if ((isMoney(lt) || lt === 'int') && (isMoney(rt) || rt === 'int')) {
            unifyMoney(lt, rt, n.line);
            return 'bool';
          }
          break;
        }
        case 'AND': case 'OR': {
          if (lt === 'bool' && rt === 'bool') return 'bool';
          break;
        }
        default: break;
      }
      throw new NetError(E.TYPE,
        `invalid operands for ${n.op}: ${fmt(lt)} and ${fmt(rt)} at line ${n.line}`);
    }
    case 'call': {
      if (n.fn === 'abs') {
        const t = checkExpr(n.args[0], ctx);
        if (t === 'int' || t === 'bps' || isMoney(t)) return t;
        throw new NetError(E.TYPE, `abs expects a numeric argument, got ${fmt(t)} at line ${n.line}`);
      }
      const a = checkExpr(n.args[0], ctx);
      const b = checkExpr(n.args[1], ctx);
      if (a === b && (a === 'int' || a === 'bps' || a === 'date')) return a;
      if ((isMoney(a) || a === 'int') && (isMoney(b) || b === 'int')) {
        return unifyMoney(a, b, n.line);
      }
      throw new NetError(E.TYPE,
        `${n.fn} expects matching numeric arguments, got ${fmt(a)} and ${fmt(b)} at line ${n.line}`);
    }
    default:
      throw new NetError(E.PARSE, `internal: unknown node ${n.t}`);
  }
}

export function typecheck(program) {
  return {
    blocks: program.blocks.map((block) => {
      const consts = new Map();
      for (const c of block.consts) {
        const ty = checkExpr(c.expr, { scope: 'const', consts });
        consts.set(c.name, { type: ty });
      }
      for (const f of block.filters) {
        const ty = checkExpr(f, { scope: 'filter', consts });
        if (ty !== 'bool') {
          throw new NetError(E.TYPE, `filter must be boolean, got ${fmt(ty)}`);
        }
      }
      for (const s of block.settles) {
        checkExpr(s.expr, { scope: 'settle', consts });
      }
      return block;
    }),
  };
}
