import { lex } from './lexer.js';
import { parseProgram } from './parser.js';
import { typecheck } from './typecheck.js';
import { compileProgram, vm } from './bytecode.js';
import { buildGraphs } from './graph.js';
import { optimize, verifySolution } from './netting.js';
import { NetError, E } from './errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCY_RE = /^[A-Z]{3}$/;

export function validateObs(data) {
  const list = Array.isArray(data) ? data : data && data.obligations;
  if (!Array.isArray(list)) {
    throw new NetError(E.PARSE, 'obs file must be a JSON array or { "obligations": [...] }');
  }
  const seen = new Set();
  return list.map((o, i) => {
    const where = `obligation #${i + 1}`;
    if (!o || typeof o !== 'object') throw new NetError(E.PARSE, `${where}: not an object`);
    for (const f of ['id', 'debtor', 'creditor', 'ccy', 'date']) {
      if (typeof o[f] !== 'string' || o[f] === '') {
        throw new NetError(E.PARSE, `${where}: missing/invalid field '${f}'`);
      }
    }
    if (seen.has(o.id)) throw new NetError(E.PARSE, `duplicate obligation id '${o.id}'`);
    seen.add(o.id);
    if (!CCY_RE.test(o.ccy)) throw new NetError(E.PARSE, `${where}: bad currency '${o.ccy}'`);
    if (!DATE_RE.test(o.date)) throw new NetError(E.PARSE, `${where}: bad date '${o.date}'`);
    if (!Number.isSafeInteger(o.amount) || o.amount <= 0) {
      throw new NetError(E.PARSE, `${where}: amount must be a positive integer of cents`);
    }
    if (o.debtor === o.creditor) {
      throw new NetError(E.PARSE, `${where}: debtor equals creditor ('${o.debtor}')`);
    }
    return {
      id: o.id, debtor: o.debtor, creditor: o.creditor,
      ccy: o.ccy, amount: o.amount, date: o.date,
    };
  });
}

function plain(v) {
  if (v.t === 'money') return { amount: v.v, ccy: v.ccy, kind: v.kind };
  return v.v;
}

export function runNetting(rulesSrc, obsData) {
  const program = parseProgram(lex(rulesSrc)); // E_PARSE
  const typed = typecheck(program); // E_CCY / E_TYPE / E_SCOPE / E_PARSE
  const blocks = compileProgram(typed); // bytecode per trade-date scope
  const obligations = validateObs(obsData);
  if (obligations.length === 0) throw new NetError(E.NO_SOL, 'no obligations provided');

  const kept = [];
  for (const ob of obligations) {
    const block = blocks.get(ob.date);
    if (!block) throw new NetError(E.PARSE, `no rules defined for trade date ${ob.date}`);
    if (!block.filterOps) { kept.push(ob); continue; }
    const env = {
      amount: { t: 'money', ccy: ob.ccy, kind: 'gross', v: ob.amount },
      ccy: { t: 'ccy', v: ob.ccy },
      debtor: { t: 'member', v: ob.debtor },
      creditor: { t: 'member', v: ob.creditor },
      id: { t: 'obid', v: ob.id },
      day: { t: 'date', v: ob.date },
    };
    if (vm(block.filterOps, env).v) kept.push(ob);
  }
  if (kept.length === 0) {
    throw new NetError(E.NO_SOL, 'no obligations survive the filters');
  }

  const graphs = buildGraphs(kept);
  const currencies = {};
  for (const [ccy, g] of [...graphs.entries()].sort()) {
    const { minCash, gross, solutions } = optimize(g);
    for (const sol of solutions) {
      if (!verifySolution(g, sol)) {
        throw new Error(`internal: solution violates net-position invariant for ${ccy}`);
      }
    }
    const settle = [];
    for (const [date, block] of [...blocks.entries()].sort()) {
      for (const s of block.settles) {
        for (const [member, pos] of [...g.positions.entries()].sort()) {
          const v = vm(s.ops, {
            position: { t: 'money', ccy, kind: 'net', v: pos },
            member: { t: 'member', v: member },
            ccy: { t: 'ccy', v: ccy },
            day: { t: 'date', v: date },
          });
          settle.push({ date, ccy, member, name: s.name, value: plain(v) });
        }
      }
    }
    currencies[ccy] = {
      gross,
      cancelled: gross - minCash,
      minCash,
      positions: Object.fromEntries([...g.positions.entries()].sort()),
      solutions,
      settle,
    };
  }
  return { ok: true, obligations: kept.length, currencies };
}
