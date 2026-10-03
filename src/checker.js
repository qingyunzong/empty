'use strict';

const { JeError } = require('./errors');

// Decimal string -> integer "units" at SCALE = 1e6 (micro-yuan).
const SCALE = 1e6;

function parseDecimal(raw) {
  const neg = raw.startsWith('-');
  const s = neg ? raw.slice(1) : raw;
  const [intPart, fracPart = ''] = s.split('.');
  let frac = (fracPart + '0000000').slice(0, 7);
  let units = Number(intPart) * SCALE;
  const frac6 = Number(frac.slice(0, 6));
  const roundDigit = Number(frac[6]);
  units += frac6 + (roundDigit >= 5 ? 1 : 0);
  return neg ? -units : units;
}

function evalConst(e) {
  switch (e.kind) {
    case 'num': return parseDecimal(e.raw);
    case 'neg': return -evalConst(e.e);
    case 'bin': {
      const a = evalConst(e.l);
      const b = evalConst(e.r);
      if (e.op === '+') return a + b;
      if (e.op === '-') return a - b;
      if (e.op === '*') return Math.round((a * b) / SCALE);
      if (b === 0) throw new JeError('E_TYPE', 'division by zero in constant expression');
      return Math.round((a / b) * SCALE);
    }
    default: return null;
  }
}

// Canonical structural key for balance proofs. Commutative ops are sorted,
// numeric subexpressions are constant-folded.
function canon(e) {
  const c = evalConst(e);
  if (c !== null) return `N${c}`;
  switch (e.kind) {
    case 'event': return `E.${e.field}`;
    case 'ref': return `R.${e.name}`;
    case 'bin': {
      const l = canon(e.l);
      const r = canon(e.r);
      if (e.op === '+' || e.op === '*') {
        return l < r ? `(${e.op} ${l} ${r})` : `(${e.op} ${r} ${l})`;
      }
      return `(${e.op} ${l} ${r})`;
    }
    case 'neg': return `(- ${canon(e.e)})`;
    default:
      throw new JeError('E_TYPE', `expression not allowed in amount: ${e.kind}`);
  }
}

function exprRefs(e, out = []) {
  switch (e.kind) {
    case 'ref': out.push(e.name); break;
    case 'bin': exprRefs(e.l, out); exprRefs(e.r, out); break;
    case 'neg': exprRefs(e.e, out); break;
    case 'total':
      throw new JeError('E_TYPE', 'dr/cr totals are only allowed in balance statements');
    default: break;
  }
  return out;
}

function proveBalanced(post) {
  const drKeys = post.legs.filter((l) => l.side === 'dr').map((l) => canon(l.amount)).sort();
  const crKeys = post.legs.filter((l) => l.side === 'cr').map((l) => canon(l.amount)).sort();
  if (drKeys.length !== crKeys.length) return false;
  return drKeys.every((k, i) => k === crKeys[i]);
}

function checkPostShape(post, where) {
  const hasDr = post.legs.some((l) => l.side === 'dr');
  const hasCr = post.legs.some((l) => l.side === 'cr');
  if (!hasDr || !hasCr) {
    throw new JeError('E_BALANCE', `post in ${where} must have at least one dr and one cr leg`);
  }
}

function substitute(e, moneyParams) {
  switch (e.kind) {
    case 'ref': {
      const sub = moneyParams.get(e.name);
      if (!sub) throw new JeError('E_SCOPE', `unknown name '${e.name}' in template expansion`);
      return sub;
    }
    case 'bin': return { kind: 'bin', op: e.op, l: substitute(e.l, moneyParams), r: substitute(e.r, moneyParams) };
    case 'neg': return { kind: 'neg', e: substitute(e.e, moneyParams) };
    default: return e;
  }
}

function checkTemplate(t, globals) {
  const localAccounts = new Map();
  for (const item of t.body) {
    if (item.kind !== 'account') continue;
    if (globals.accounts.has(item.code)) {
      throw new JeError('E_TYPE', `template '${t.name}' redeclares global account ${item.code}`);
    }
    if (localAccounts.has(item.code)) {
      throw new JeError('E_TYPE', `duplicate account ${item.code} in template '${t.name}'`);
    }
    localAccounts.set(item.code, item);
  }
  const paramTypes = new Map(); // name -> 'account' | 'money'
  const markParam = (name, type) => {
    const prev = paramTypes.get(name);
    if (prev && prev !== type) {
      throw new JeError('E_TYPE', `parameter '${name}' of template '${t.name}' used as both ${prev} and ${type}`);
    }
    paramTypes.set(name, type);
  };
  const paramSet = new Set(t.params);
  for (const item of t.body) {
    if (item.kind !== 'post') continue;
    checkPostShape(item, `template '${t.name}'`);
    for (const leg of item.legs) {
      if (paramSet.has(leg.account)) {
        markParam(leg.account, 'account');
      } else if (!localAccounts.has(leg.account) && !globals.accounts.has(leg.account)) {
        throw new JeError('E_SCOPE', `unknown account '${leg.account}' in template '${t.name}'`);
      }
      for (const ref of exprRefs(leg.amount)) {
        if (!paramSet.has(ref)) {
          throw new JeError('E_SCOPE', `unknown name '${ref}' in template '${t.name}'`);
        }
        markParam(ref, 'money');
      }
    }
    if (!proveBalanced(item)) {
      throw new JeError('E_BALANCE', `cannot statically prove debit == credit for post in template '${t.name}'`);
    }
  }
  for (const p of t.params) {
    if (!paramTypes.has(p)) {
      throw new JeError('E_TYPE', `parameter '${p}' of template '${t.name}' is never used`);
    }
  }
  return { decl: t, localAccounts, paramTypes };
}

function check(program) {
  const globals = { accounts: new Map(), periods: new Map(), templates: new Map(), batches: [] };
  for (const d of program.decls) {
    if (d.kind === 'account') {
      if (globals.accounts.has(d.code)) throw new JeError('E_TYPE', `duplicate account ${d.code}`);
      globals.accounts.set(d.code, d);
    } else if (d.kind === 'period') {
      if (globals.periods.has(d.id)) throw new JeError('E_TYPE', `duplicate period ${d.id}`);
      globals.periods.set(d.id, d);
    } else if (d.kind === 'template') {
      if (globals.templates.has(d.name)) throw new JeError('E_TYPE', `duplicate template ${d.name}`);
      globals.templates.set(d.name, d);
    } else if (d.kind === 'batch') {
      globals.batches.push(d);
    }
  }

  const checkedTemplates = new Map();
  for (const [name, t] of globals.templates) {
    checkedTemplates.set(name, checkTemplate(t, globals));
  }

  const checkedBatches = globals.batches.map((b) => checkBatch(b, globals, checkedTemplates));
  return {
    accounts: globals.accounts,
    periods: globals.periods,
    templates: checkedTemplates,
    batches: checkedBatches,
  };
}

function checkBatch(b, globals, checkedTemplates) {
  const period = globals.periods.get(b.period);
  if (!period) throw new JeError('E_PERIOD', `batch '${b.name}': unknown period '${b.period}'`);
  if (period.state === 'closed') {
    throw new JeError('E_PERIOD', `batch '${b.name}': period '${b.period}' is closed`);
  }

  // Scope: globals plus accounts introduced by `use` expansions in this batch.
  const scope = new Map(globals.accounts);
  const expanded = [];
  let hasBalance = false;

  const visibleAccount = (code, where) => {
    if (!scope.has(code)) {
      throw new JeError('E_SCOPE', `unknown or out-of-scope account '${code}' in ${where}`);
    }
    return code;
  };

  for (const item of b.body) {
    if (item.kind === 'post') {
      expanded.push(item);
    } else if (item.kind === 'balance') {
      expanded.push(item);
      hasBalance = true;
    } else if (item.kind === 'use') {
      const tpl = checkedTemplates.get(item.template);
      if (!tpl) throw new JeError('E_SCOPE', `unknown template '${item.template}' in batch '${b.name}'`);
      if (item.args.length !== tpl.decl.params.length) {
        throw new JeError('E_TYPE', `template '${item.template}' expects ${tpl.decl.params.length} argument(s), got ${item.args.length}`);
      }
      const accountParams = new Map();
      const moneyParams = new Map();
      tpl.decl.params.forEach((p, i) => {
        const type = tpl.paramTypes.get(p);
        const arg = item.args[i];
        if (type === 'account') {
          let code = null;
          if (arg.kind === 'ref') code = arg.name;
          else if (arg.kind === 'num' && !arg.raw.includes('.')) code = arg.raw;
          if (code === null || !scope.has(code)) {
            throw new JeError('E_SCOPE', `argument for account parameter '${p}' of template '${item.template}' must be a visible account`);
          }
          accountParams.set(p, code);
        } else {
          for (const ref of exprRefs(arg)) {
            throw new JeError('E_SCOPE', `unknown name '${ref}' in argument to template '${item.template}'`);
          }
          moneyParams.set(p, arg);
        }
      });
      for (const tItem of tpl.decl.body) {
        if (tItem.kind === 'account') {
          if (!scope.has(tItem.code)) scope.set(tItem.code, tItem);
        } else if (tItem.kind === 'post') {
          const legs = tItem.legs.map((leg) => ({
            side: leg.side,
            account: accountParams.get(leg.account) || leg.account,
            amount: substitute(leg.amount, moneyParams),
          }));
          expanded.push({ kind: 'post', legs, from: `template '${item.template}'` });
        }
      }
    }
  }

  for (const item of expanded) {
    if (item.kind === 'post') {
      checkPostShape(item, `batch '${b.name}'`);
      for (const leg of item.legs) {
        visibleAccount(leg.account, `batch '${b.name}'`);
        exprRefs(leg.amount).forEach((ref) => {
          throw new JeError('E_SCOPE', `unknown name '${ref}' in batch '${b.name}'`);
        });
      }
      if (!proveBalanced(item) && !hasBalance) {
        throw new JeError('E_BALANCE', `cannot statically prove debit == credit for post in batch '${b.name}'; add a 'balance' assertion`);
      }
    } else if (item.kind === 'balance') {
      for (const side of [item.left, item.right]) {
        walkTotals(side, (t) => {
          if (t.account !== null) visibleAccount(t.account, `batch '${b.name}' balance`);
        });
      }
    }
  }

  return { name: b.name, period: b.period, on: b.on, body: expanded };
}

function walkTotals(e, fn) {
  switch (e.kind) {
    case 'total': fn(e); break;
    case 'bin': walkTotals(e.l, fn); walkTotals(e.r, fn); break;
    case 'neg': walkTotals(e.e, fn); break;
    case 'ref': throw new JeError('E_SCOPE', `unknown name '${e.name}' in balance expression`);
    default: break;
  }
}

module.exports = { check, parseDecimal, canon, SCALE };
