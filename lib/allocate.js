'use strict';

const { solve, minimalConflict } = require('./solver');

class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_INPUT';
  }
}

const EPS = 1e-9;
const DEFAULT_BUDGET = 1_000_000;

function round2(x) {
  return Math.round(x * 100) / 100;
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputError('input must be a JSON object');
  }
  if (typeof input.totalAmount !== 'number' || !(input.totalAmount > 0)) {
    throw new InputError('totalAmount must be a positive number');
  }
  if (!Array.isArray(input.costCenters) || input.costCenters.length === 0) {
    throw new InputError('costCenters must be a non-empty array');
  }
  const seen = new Set();
  for (const c of input.costCenters) {
    if (!c || typeof c.id !== 'string') throw new InputError('each cost center needs a string id');
    if (seen.has(c.id)) throw new InputError(`duplicate cost center id ${c.id}`);
    seen.add(c.id);
    if (!Array.isArray(c.tiers) || c.tiers.length === 0) {
      throw new InputError(`cost center ${c.id} needs a non-empty tiers array`);
    }
    for (const t of c.tiers) {
      if (typeof t !== 'number' || t < 0 || t > 100) {
        throw new InputError(`cost center ${c.id} has invalid tier ${t}`);
      }
    }
  }
}

function run(input) {
  validateInput(input);
  const total = input.totalAmount;
  const budget = Number.isInteger(input.searchBudget) && input.searchBudget >= 0
    ? input.searchBudget
    : DEFAULT_BUDGET;
  let nodesUsed = 0;
  const trace = [];
  let seq = 0;
  const log = (entry) => trace.push({ seq: seq++, ...entry });

  // Propagation: delete ratios whose amount violates [minAmount, maxAmount].
  const centers = input.costCenters.map((c) => {
    const minAmount = c.minAmount ?? 0;
    const maxAmount = c.maxAmount ?? Infinity;
    const tiers = [...new Set(c.tiers)].sort((a, b) => a - b);
    const domain = [];
    const removed = [];
    for (const ratio of tiers) {
      const amount = (total * ratio) / 100;
      if (amount < minAmount - EPS || amount > maxAmount + EPS) removed.push(ratio);
      else domain.push(ratio);
    }
    if (removed.length) {
      log({ event: 'propagate', center: c.id, removedRatios: removed, reason: 'amount-out-of-bounds' });
    }
    return { id: c.id, tiers, minAmount, maxAmount, domain };
  });
  const byId = new Map(centers.map((c) => [c.id, c]));

  function doSolve(scope, target) {
    const remainingBudget = Math.max(budget - nodesUsed, 0);
    const res = solve(scope.map((c) => ({ id: c.id, domain: c.domain })), target, remainingBudget);
    nodesUsed += res.nodes;
    log({ event: 'solve', scope: scope.map((c) => c.id), target, status: res.status, nodes: res.nodes });
    return res;
  }

  let ratios = null;
  let locks = new Map();
  let status = 'FEASIBLE';
  let conflict = null;
  const layers = [];
  const cancelledTargets = new Set();

  function computeConflict() {
    return minimalConflict(centers, locks) ?? [];
  }

  function violates(center, ratio) {
    const amount = (total * ratio) / 100;
    return !center.tiers.includes(ratio)
      || amount < center.minAmount - EPS
      || amount > center.maxAmount + EPS;
  }

  // Base allocation over all centers.
  {
    const res = doSolve(centers, 100);
    if (res.status === 'FEASIBLE') {
      ratios = {};
      centers.forEach((c, i) => { ratios[c.id] = res.assignment[i]; });
      log({ event: 'allocated', phase: 'base', ratios: { ...ratios } });
    } else {
      status = res.status;
      if (status === 'UNSAT') conflict = computeConflict();
    }
  }

  function snapshot() {
    return { ratios: { ...ratios }, locks: new Map(locks) };
  }

  function applyAdjustment(adj) {
    if (!adj || typeof adj.id !== 'string') throw new InputError('each adjustment needs a string id');
    if (status !== 'FEASIBLE') {
      log({ event: 'adjust', id: adj.id, skipped: true, reason: `status-${status.toLowerCase()}` });
      return;
    }
    if (adj.ratios) {
      const entries = Object.entries(adj.ratios);
      for (const [id] of entries) {
        if (!byId.has(id)) throw new InputError(`adjustment ${adj.id}: unknown cost center ${id}`);
      }
      if (entries.length !== centers.length) {
        throw new InputError(`adjustment ${adj.id}: ratios must cover all ${centers.length} cost centers`);
      }
      const sum = entries.reduce((s, [, v]) => s + v, 0);
      if (sum !== 100) {
        throw new InputError(`adjustment ${adj.id}: ratios sum to ${sum}, expected 100`);
      }
      const snap = snapshot();
      const bad = entries.filter(([id, v]) => violates(byId.get(id), v)).map(([id]) => id);
      if (bad.length) {
        status = 'UNSAT';
        conflict = bad.slice().sort();
        log({ event: 'adjust', id: adj.id, kind: 'ratios', status: 'UNSAT', violated: bad });
        return;
      }
      const changed = entries
        .filter(([id, v]) => ratios[id] !== v)
        .map(([id, v]) => ({ center: id, from: ratios[id], to: v }));
      ratios = Object.fromEntries(entries);
      locks = new Map(entries.map(([id, v]) => [id, v]));
      layers.push({ id: adj.id, ...snap });
      log({ event: 'adjust', id: adj.id, kind: 'ratios', status: 'FEASIBLE', changed });
      return;
    }
    if (adj.set) {
      const entries = Object.entries(adj.set);
      for (const [id, v] of entries) {
        if (!byId.has(id)) throw new InputError(`adjustment ${adj.id}: unknown cost center ${id}`);
        if (typeof v !== 'number') throw new InputError(`adjustment ${adj.id}: invalid ratio for ${id}`);
      }
      const snap = snapshot();
      const newLocks = new Map(locks);
      for (const [id, v] of entries) newLocks.set(id, v);
      const bad = [...newLocks.entries()].filter(([id, v]) => violates(byId.get(id), v)).map(([id]) => id);
      if (bad.length) {
        status = 'UNSAT';
        conflict = bad.slice().sort();
        log({ event: 'adjust', id: adj.id, kind: 'set', status: 'UNSAT', violated: bad });
        return;
      }
      locks = newLocks;
      const lockedSum = [...locks.values()].reduce((a, b) => a + b, 0);
      const unlocked = centers.filter((c) => !locks.has(c.id));
      const target = 100 - lockedSum;
      if (target < 0 || (unlocked.length === 0 && target !== 0)) {
        status = 'UNSAT';
        conflict = computeConflict();
        log({ event: 'adjust', id: adj.id, kind: 'set', status: 'UNSAT', lockedSum });
        return;
      }
      if (unlocked.length === 0) {
        const changed = centers
          .filter((c) => ratios[c.id] !== locks.get(c.id))
          .map((c) => ({ center: c.id, from: ratios[c.id], to: locks.get(c.id) }));
        ratios = Object.fromEntries(locks);
        layers.push({ id: adj.id, ...snap });
        log({ event: 'adjust', id: adj.id, kind: 'set', status: 'FEASIBLE', changed });
        return;
      }
      // Incremental recompute: only unlocked centers are re-solved.
      const res = doSolve(unlocked, target);
      if (res.status === 'FEASIBLE') {
        const changed = [];
        for (const [id, v] of locks) {
          if (ratios[id] !== v) changed.push({ center: id, from: ratios[id], to: v });
          ratios[id] = v;
        }
        unlocked.forEach((c, i) => {
          if (ratios[c.id] !== res.assignment[i]) {
            changed.push({ center: c.id, from: ratios[c.id], to: res.assignment[i] });
          }
          ratios[c.id] = res.assignment[i];
        });
        layers.push({ id: adj.id, ...snap });
        log({ event: 'adjust', id: adj.id, kind: 'set', status: 'FEASIBLE', changed });
      } else {
        status = res.status;
        if (status === 'UNSAT') conflict = computeConflict();
        log({ event: 'adjust', id: adj.id, kind: 'set', status });
      }
      return;
    }
    throw new InputError(`adjustment ${adj.id}: needs either "set" or "ratios"`);
  }

  function applyCancellation(cx) {
    if (!cx || typeof cx.target !== 'string') throw new InputError('each cancellation needs a string target');
    if (cancelledTargets.has(cx.target)) {
      throw new InputError(`document ${cx.target} already cancelled`);
    }
    const idx = layers.findIndex((l) => l.id === cx.target);
    if (idx === -1) throw new InputError(`cancellation target ${cx.target} not found`);
    const layer = layers[idx];
    cancelledTargets.add(cx.target);
    const dropped = layers.splice(idx).map((l) => l.id);
    ratios = { ...layer.ratios };
    locks = new Map(layer.locks);
    status = 'FEASIBLE';
    conflict = null;
    log({
      event: 'cancel',
      target: cx.target,
      restored: { ...ratios },
      droppedLayers: dropped.filter((id) => id !== cx.target),
    });
  }

  for (const adj of input.adjustments ?? []) applyAdjustment(adj);
  for (const cx of input.cancellations ?? []) applyCancellation(cx);

  const allocation = status === 'FEASIBLE'
    ? centers.map((c) => ({
      center: c.id,
      ratio: ratios[c.id],
      amount: round2((total * ratios[c.id]) / 100),
      locked: locks.has(c.id),
    }))
    : null;
  const lockedAmount = allocation
    ? round2(allocation.filter((a) => a.locked).reduce((s, a) => s + a.amount, 0))
    : null;

  return {
    status,
    totalAmount: total,
    allocation,
    lockedAmount,
    pendingAmount: allocation ? round2(total - lockedAmount) : null,
    conflictCenters: status === 'UNSAT' ? conflict : null,
    nodesSearched: nodesUsed,
    trace,
  };
}

module.exports = { run, InputError };
