import { NetError, E } from './errors.js';
import { parse } from './parser.js';
import { compile, run } from './bytecode.js';
import { buildGraph, netPositions, totalAmount } from './graph.js';
import { solveGraph, residualAfter } from './solver.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCY_RE = /^[A-Z]{3}$/;

export function validateObligations(data) {
  const list = data && Array.isArray(data.obligations) ? data.obligations : null;
  if (!list) throw new NetError(E.PARSE, 'obs.json must contain an "obligations" array');
  const seen = new Set();
  return list.map((o, i) => {
    const where = `obligation[${i}]`;
    if (typeof o !== 'object' || o === null) throw new NetError(E.PARSE, `${where}: not an object`);
    for (const f of ['id', 'day', 'from', 'to', 'ccy']) {
      if (typeof o[f] !== 'string' || o[f] === '') throw new NetError(E.PARSE, `${where}: field ${f} must be a non-empty string`);
    }
    if (seen.has(o.id)) throw new NetError(E.PARSE, `${where}: duplicate obligation id ${o.id}`);
    seen.add(o.id);
    if (!DAY_RE.test(o.day)) throw new NetError(E.PARSE, `${where}: bad day ${o.day}`);
    if (!CCY_RE.test(o.ccy)) throw new NetError(E.PARSE, `${where}: bad currency ${o.ccy}`);
    if (o.from === o.to) throw new NetError(E.PARSE, `${where}: self obligation ${o.from}`);
    if (!Number.isSafeInteger(o.amount) || o.amount <= 0) {
      throw new NetError(E.PARSE, `${where}: amount must be a positive integer (cents)`);
    }
    return { id: o.id, day: o.day, from: o.from, to: o.to, ccy: o.ccy, amount: BigInt(o.amount) };
  });
}

// Compile every scope's filter/nettable exactly once (static type check).
export function compileProgram(prog) {
  const compileScope = (scope, where) => {
    const out = { expects: scope.expects };
    if (scope.filter) {
      const { code, type } = compile(scope.filter);
      if (type.kind !== 'bool') throw new NetError(E.PARSE, `${where}: filter must be bool, got ${type.kind}`);
      out.filter = code;
    }
    if (scope.nettable) {
      const { code, type } = compile(scope.nettable);
      if (type.kind === 'money' && type.phase === 'net') {
        throw new NetError(E.PARSE, `${where}: nettable must be gross money, not net (cannot net a net)`);
      }
      if (type.kind !== 'money' && type.kind !== 'int') {
        throw new NetError(E.PARSE, `${where}: nettable must be money or int, got ${type.kind}`);
      }
      out.nettable = code;
    }
    return out;
  };
  const compiled = { global: compileScope(prog.global, 'global scope'), days: new Map() };
  for (const [date, scope] of prog.days) {
    compiled.days.set(date, compileScope(scope, `day ${date}`));
  }
  return compiled;
}

function scopeFor(compiled, day) {
  const d = compiled.days.get(day);
  return {
    filter: (d && d.filter) || compiled.global.filter || null,
    nettable: (d && d.nettable) || compiled.global.nettable || null,
  };
}

// Full pipeline: rules source + obligations data -> proof object.
export function runNetting(rulesSrc, obsData) {
  const prog = parse(rulesSrc);
  const compiled = compileProgram(prog);
  const obligations = validateObligations(obsData);

  const selected = [];
  for (const obl of obligations) {
    const scope = scopeFor(compiled, obl.day);
    if (scope.filter) {
      const v = run(scope.filter, obl);
      if (!v.v) continue;
    }
    let amount;
    if (scope.nettable) {
      const v = run(scope.nettable, obl);
      amount = v.v;
    } else {
      amount = obl.amount;
    }
    if (amount < 0n) {
      throw new NetError(E.NO_SOL, `nettable amount is negative for obligation ${obl.id}`);
    }
    if (amount === 0n) continue;
    selected.push({ ...obl, amount });
  }
  if (selected.length === 0) {
    throw new NetError(E.NO_SOL, 'no obligations selected by rules');
  }

  const byCcy = buildGraph(selected);
  const expects = [...prog.global.expects];
  for (const scope of prog.days.values()) expects.push(...scope.expects);

  const proof = { version: 1, currencies: {} };
  const foundCycles = new Set();

  for (const ccy of [...byCcy.keys()].sort()) {
    const edges = byCcy.get(ccy);
    const gross = totalAmount(edges);
    const nets = netPositions(edges);
    const { minCash, solutions, truncated } = solveGraph(edges);

    const proofSolutions = solutions.map((sol) => {
      const residual = residualAfter(edges, sol);
      // Internal consistency: net positions must be preserved.
      const resNets = netPositions(residual);
      for (const [m, v] of nets) {
        if ((resNets.get(m) ?? 0n) !== v) {
          throw new NetError(E.NO_SOL, `internal: net position of ${m} changed for ${ccy}`);
        }
      }
      let cancelled = 0n;
      for (const step of sol) {
        cancelled += step.amount * BigInt(step.members.length);
        foundCycles.add(`${ccy}:${step.key}`);
      }
      if (gross - cancelled !== totalAmount(residual)) {
        throw new NetError(E.NO_SOL, `internal: cancellation accounting mismatch for ${ccy}`);
      }
      return {
        cycles: sol.map((s) => ({ cycle: s.key, members: s.members, amount: s.amount })),
        residual: [...residual.entries()]
          .filter(([, a]) => a > 0n)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, a]) => { const [from, to] = k.split('>'); return { from, to, amount: a }; }),
        residualTotal: totalAmount(residual),
      };
    });

    const oblIds = selected.filter((o) => o.ccy === ccy).map((o) => o.id).sort();
    proof.currencies[ccy] = {
      obligations: oblIds,
      gross,
      minCash,
      netPositions: Object.fromEntries([...nets.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      solutions: proofSolutions,
      truncated,
    };
  }

  for (const exp of expects) {
    const hit = [...byCcy.keys()].some((ccy) => foundCycles.has(`${ccy}:${exp.key}`));
    if (!hit) {
      throw new NetError(E.NO_SOL, `expected cycle ${exp.key} not found in any optimal solution`);
    }
  }

  return proof;
}

export function proofToJson(proof) {
  return JSON.stringify(proof, (k, v) => {
    if (typeof v === 'bigint') {
      return v <= 9007199254740991n && v >= -9007199254740991n ? Number(v) : v.toString();
    }
    return v;
  }, 2);
}
