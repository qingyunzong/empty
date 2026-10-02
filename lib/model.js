'use strict';

const crypto = require('node:crypto');

const SCALE = 10000;
const MAX_OBLIGATIONS = 20;

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function signum(x) {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

function planKey(ids) {
  return ids.join(',');
}

function validateObligations(list) {
  if (!Array.isArray(list)) throw new Error('obligations must be an array');
  const seen = new Set();
  for (const o of list) {
    if (!o || typeof o.id !== 'string' || o.id === '') {
      throw new Error('each obligation needs a non-empty string id');
    }
    if (seen.has(o.id)) throw new Error(`duplicate obligation id: ${o.id}`);
    seen.add(o.id);
    if (typeof o.from !== 'string' || typeof o.to !== 'string' || o.from === '' || o.to === '' || o.from === o.to) {
      throw new Error(`obligation ${o.id}: invalid parties`);
    }
    if (!Number.isInteger(o.amount) || o.amount <= 0) {
      throw new Error(`obligation ${o.id}: amount must be a positive integer`);
    }
    if (!Number.isInteger(o.day) || o.day < 0) {
      throw new Error(`obligation ${o.id}: day must be a non-negative integer`);
    }
  }
}

function normalizeConstraints(raw) {
  const c = { feeBps: 0, freezeBps: 0, freezeMarginBps: 0, timeBps: 0, ...raw };
  for (const k of ['feeBps', 'freezeBps', 'freezeMarginBps', 'timeBps', 'maxFreeze', 'dailyLimit']) {
    if (!Number.isInteger(c[k]) || c[k] < 0) {
      throw new Error(`constraints.${k} must be a non-negative integer`);
    }
  }
  return c;
}

function partyTotals(obligations) {
  const totals = new Map();
  for (const o of obligations) {
    totals.set(o.from, (totals.get(o.from) || 0) - o.amount);
    totals.set(o.to, (totals.get(o.to) || 0) + o.amount);
  }
  return totals;
}

function evaluateMask(obligations, constraints, totals, mask) {
  const netted = new Map();
  let grossVolume = 0;
  let grossAmountDays = 0;
  let nettedMaxDay = 0;
  let anyNetted = false;
  for (let i = 0; i < obligations.length; i++) {
    const o = obligations[i];
    if ((mask & (1 << i)) !== 0) {
      anyNetted = true;
      netted.set(o.from, (netted.get(o.from) || 0) - o.amount);
      netted.set(o.to, (netted.get(o.to) || 0) + o.amount);
      if (o.day > nettedMaxDay) nettedMaxDay = o.day;
    } else {
      grossVolume += o.amount;
      grossAmountDays += o.amount * o.day;
    }
  }
  for (const [party, value] of netted) {
    if (value !== 0 && signum(value) !== signum(totals.get(party) || 0)) {
      return { feasible: false, reason: `sign:${party}` };
    }
  }
  let nettedVolume = 0;
  for (const value of netted.values()) {
    if (value > 0) nettedVolume += value;
  }
  const volume = nettedVolume + grossVolume;
  const freeze = Math.ceil((volume * (SCALE + constraints.freezeMarginBps)) / SCALE);
  if (freeze > constraints.maxFreeze) {
    return { feasible: false, reason: `freeze:${freeze}>${constraints.maxFreeze}` };
  }
  if (volume > constraints.dailyLimit) {
    return { feasible: false, reason: `daily:${volume}>${constraints.dailyLimit}` };
  }
  const amountDays = grossAmountDays + (anyNetted ? nettedMaxDay * nettedVolume : 0);
  const cost = volume * constraints.feeBps + freeze * constraints.freezeBps + amountDays * constraints.timeBps;
  return { feasible: true, volume, freeze, amountDays, cost };
}

function maskIds(obligations, mask) {
  const ids = [];
  for (let i = 0; i < obligations.length; i++) {
    if ((mask & (1 << i)) !== 0) ids.push(obligations[i].id);
  }
  return ids.sort();
}

function settlementLegs(obligations, mask) {
  const netted = new Map();
  const gross = [];
  for (let i = 0; i < obligations.length; i++) {
    const o = obligations[i];
    if ((mask & (1 << i)) !== 0) {
      netted.set(o.from, (netted.get(o.from) || 0) - o.amount);
      netted.set(o.to, (netted.get(o.to) || 0) + o.amount);
    } else {
      gross.push({ id: o.id, from: o.from, to: o.to, amount: o.amount, day: o.day });
    }
  }
  const nettedLegs = [...netted.entries()]
    .filter(([, v]) => v !== 0)
    .map(([party, amount]) => ({ party, amount }))
    .sort((a, b) => (a.party < b.party ? -1 : a.party > b.party ? 1 : 0));
  return { netted: nettedLegs, gross };
}

function optimize(obligations, constraints) {
  if (obligations.length > MAX_OBLIGATIONS) {
    throw new Error(`too many obligations: ${obligations.length} > ${MAX_OBLIGATIONS}`);
  }
  const totals = partyTotals(obligations);
  const evaluations = [];
  const feasible = [];
  const space = 1 << obligations.length;
  for (let mask = 0; mask < space; mask++) {
    const ids = maskIds(obligations, mask);
    const r = evaluateMask(obligations, constraints, totals, mask);
    if (r.feasible) {
      feasible.push({ mask, ids, ...r });
      evaluations.push({ ids, feasible: true, cost: r.cost });
    } else {
      evaluations.push({ ids, feasible: false, reason: r.reason });
    }
  }
  const result = { evaluations, feasibleCount: feasible.length, tied: [], selected: null, certificate: null };
  if (feasible.length === 0) return result;
  let best = Infinity;
  for (const f of feasible) {
    if (f.cost < best) best = f.cost;
  }
  const tied = feasible
    .filter((f) => f.cost === best)
    .sort((a, b) => {
      const ka = planKey(a.ids);
      const kb = planKey(b.ids);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const selected = tied[0];
  const legs = settlementLegs(obligations, selected.mask);
  result.tied = tied.map((t) => ({
    ids: t.ids, cost: t.cost, volume: t.volume, freeze: t.freeze, amountDays: t.amountDays,
  }));
  result.selected = {
    ids: selected.ids,
    mask: selected.mask,
    cost: selected.cost,
    volume: selected.volume,
    freeze: selected.freeze,
    amountDays: selected.amountDays,
    costBreakdown: {
      fee: selected.volume * constraints.feeBps,
      freezeOccupation: selected.freeze * constraints.freezeBps,
      timing: selected.amountDays * constraints.timeBps,
      scale: SCALE,
    },
    netted: legs.netted,
    gross: legs.gross,
  };
  const tiedPlans = result.tied.map((t) => ({ ids: t.ids, cost: t.cost, volume: t.volume, freeze: t.freeze }));
  result.certificate = {
    version: 1,
    algorithm: 'exhaustive-bitmask-v1',
    obligationsHash: sha256hex(canonical(obligations)),
    constraintsHash: sha256hex(canonical(constraints)),
    feasibleCount: feasible.length,
    optimalCost: best,
    tiedPlans,
    candidateSetHash: sha256hex(canonical(tiedPlans)),
    selectionRule: 'min-cost-then-lexicographic-sorted-ids',
    selectedKey: planKey(selected.ids),
  };
  return result;
}

function reversePlan(selected) {
  return {
    kind: 'reverse-plan',
    reverses: selected.ids,
    netted: selected.netted.map((l) => ({ party: l.party, amount: -l.amount })),
    gross: selected.gross.map((g) => ({ id: g.id, from: g.to, to: g.from, amount: g.amount, day: g.day })),
  };
}

module.exports = {
  SCALE,
  MAX_OBLIGATIONS,
  canonical,
  sha256hex,
  signum,
  planKey,
  validateObligations,
  normalizeConstraints,
  partyTotals,
  evaluateMask,
  maskIds,
  settlementLegs,
  optimize,
  reversePlan,
};
