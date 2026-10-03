'use strict';

const { planInvalid } = require('./errors');

function normalizeMoves(moveBefore) {
  if (moveBefore == null) return [];
  if (Array.isArray(moveBefore)) {
    return moveBefore.map((m) => {
      if (Array.isArray(m)) return { id: m[0], before: m[1] };
      if (m && typeof m === 'object') return { id: m.id, before: m.before };
      throw planInvalid('moveBefore entries must be [id, before] pairs or {id, before}');
    });
  }
  if (typeof moveBefore === 'object') {
    return Object.entries(moveBefore).map(([id, before]) => ({ id, before }));
  }
  throw planInvalid('moveBefore must be an object or an array');
}

function netByAccount(entries) {
  const net = new Map();
  for (const e of entries) net.set(e.account, (net.get(e.account) || 0) + e.amount);
  return net;
}

function checkCausality(entries) {
  const index = new Map(entries.map((e, i) => [e.id, i]));
  for (const e of entries) {
    if (e.type === 'REVERSAL') {
      const ref = index.get(e.refId);
      if (ref === undefined) {
        throw planInvalid(`REVERSAL ${e.id} references unknown entry ${e.refId}`);
      }
      if (ref > index.get(e.id)) {
        throw planInvalid(`REVERSAL ${e.id} precedes its original ${e.refId}`);
      }
    }
  }
}

// Pure plan application. Returns the rewritten entry list or throws E_PLAN_INVALID.
function applyPlan(entries, plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw planInvalid('plan must be an object');
  }
  const dropIds = plan.dropIds == null ? [] : plan.dropIds;
  const fixAmounts = plan.fixAmounts == null ? {} : plan.fixAmounts;
  const moves = normalizeMoves(plan.moveBefore);
  if (!Array.isArray(dropIds)) throw planInvalid('dropIds must be an array');
  if (typeof fixAmounts !== 'object' || Array.isArray(fixAmounts)) {
    throw planInvalid('fixAmounts must be an object');
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  const drops = new Set(dropIds);

  for (const id of drops) {
    if (!byId.has(id)) throw planInvalid(`dropIds: unknown entry ${id}`);
  }
  for (const [id, value] of Object.entries(fixAmounts)) {
    if (!byId.has(id)) throw planInvalid(`fixAmounts: unknown entry ${id}`);
    if (drops.has(id)) throw planInvalid(`fixAmounts: ${id} is also dropped`);
    if (!Number.isSafeInteger(value)) {
      throw planInvalid(`fixAmounts: amount for ${id} must be a safe integer`);
    }
  }
  for (const m of moves) {
    if (!byId.has(m.id)) throw planInvalid(`moveBefore: unknown entry ${m.id}`);
    if (drops.has(m.id)) throw planInvalid(`moveBefore: ${m.id} is dropped`);
    if (!byId.has(m.before)) throw planInvalid(`moveBefore: unknown anchor ${m.before}`);
    if (drops.has(m.before)) throw planInvalid(`moveBefore: anchor ${m.before} is dropped`);
    if (m.id === m.before) throw planInvalid(`moveBefore: cannot move ${m.id} before itself`);
  }

  let result = entries.map((e) =>
    fixAmounts[e.id] !== undefined ? { ...e, amount: fixAmounts[e.id] } : { ...e }
  );
  result = result.filter((e) => !drops.has(e.id));
  for (const m of moves) {
    const from = result.findIndex((e) => e.id === m.id);
    const [item] = result.splice(from, 1);
    const to = result.findIndex((e) => e.id === m.before);
    result.splice(to, 0, item);
  }

  const before = netByAccount(entries);
  const after = netByAccount(result);
  for (const account of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(account) || 0) !== (after.get(account) || 0)) {
      throw planInvalid(`net amount changed for account ${account}`);
    }
  }
  checkCausality(result);
  return result;
}

module.exports = { applyPlan, netByAccount, checkCausality, normalizeMoves };
