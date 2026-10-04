'use strict';

const path = require('path');
const crypto = require('crypto');
const { solve, emptyState } = require('./solver');
const { Store } = require('./store');

class PlanError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function applyOpToState(state, op) {
  const d = op.data || {};
  switch (op.op) {
    case 'shift':
      state.shifts[d.id] = { capacity: d.capacity };
      break;
    case 'mold':
      state.molds[d.id] = { life: d.life };
      break;
    case 'setup':
      state.setup[d.mold] = d.minutes;
      break;
    case 'changeover':
      (state.changeover[d.from] ||= {})[d.to] = d.minutes;
      break;
    case 'insert':
      state.jobs[d.job] = { mold: d.mold, shots: d.shots, duration: d.duration };
      break;
    case 'assign':
      state.pinned[d.job] = d.shift;
      state.pinMeta[d.job] = { term: op.term, counter: op.counter };
      break;
    case 'unassign':
      delete state.pinned[d.job];
      delete state.pinMeta[d.job];
      break;
    case 'maintenance':
      state.maintenance.push({
        id: d.id, mold: d.mold, shift: d.shift, duration: d.duration, locked: !!d.locked
      });
      break;
    case 'pend':
      if (!state.pending.includes(d.job)) state.pending.push(d.job);
      delete state.pinned[d.job];
      delete state.pinMeta[d.job];
      break;
    case 'unpend': {
      const i = state.pending.indexOf(d.job);
      if (i >= 0) state.pending.splice(i, 1);
      break;
    }
    default:
      throw new PlanError('USAGE', 2, `unknown op: ${op.op}`);
  }
}

function dominates(a, b) {
  const av = a.vv || {};
  const bv = b.vv || {};
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  let strict = false;
  for (const k of keys) {
    const x = av[k] || 0;
    const y = bv[k] || 0;
    if (x < y) return false;
    if (x > y) strict = true;
  }
  return strict;
}

function cmpStamp(a, b) {
  if ((a.counter || 0) !== (b.counter || 0)) return (a.counter || 0) - (b.counter || 0);
  if (a.term !== b.term) return a.term < b.term ? -1 : 1;
  return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
}

// Version-vector conflict resolution, deterministic for a given op set so
// both terminals converge after sync: causally later ops win; concurrent ops
// are ordered by (counter, term, opId).
function resolveGroup(group) {
  let winner = group[0];
  for (const cand of group.slice(1)) {
    if (dominates(cand, winner)) winner = cand;
    else if (!dominates(winner, cand) && cmpStamp(cand, winner) > 0) winner = cand;
  }
  return winner;
}

function resolveOps(ops) {
  const dataGroups = new Map(); // per-job insert ops
  const pinGroups = new Map();  // per-job assign/unassign/pend/unpend ops
  const out = [];
  for (const op of ops) {
    const job = op.data && op.data.job;
    if (op.op === 'insert') {
      if (!dataGroups.has(job)) dataGroups.set(job, []);
      dataGroups.get(job).push(op);
    } else if (op.op === 'assign' || op.op === 'unassign' || op.op === 'pend' || op.op === 'unpend') {
      if (!pinGroups.has(job)) pinGroups.set(job, []);
      pinGroups.get(job).push(op);
    } else {
      out.push(op);
    }
  }
  for (const g of dataGroups.values()) out.push(resolveGroup(g));
  for (const g of pinGroups.values()) out.push(resolveGroup(g));
  return out;
}

function budgetManifest(state) {
  const shifts = {};
  const molds = {};
  for (const [id, s] of Object.entries(state.shifts)) shifts[id] = s.capacity;
  for (const [id, m] of Object.entries(state.molds)) molds[id] = m.life;
  return { shifts, molds };
}

class Planner {
  constructor(dir, opts = {}) {
    this.store = new Store(dir);
    this.termId = opts.termId || null;
    this.memo = { order: new Map(), assign: new Map() };
    this.state = emptyState();
    this.ops = [];
    this.certificate = null;
    this.recovery = null;
    this.meta = null;
  }

  static open(dir, opts = {}) {
    const p = new Planner(dir, opts);
    const rec = p.store.recover();
    p.recovery = {
      journalTruncated: !!rec.journalTruncated,
      planTmpDiscarded: !!rec.planTmpDiscarded,
      budgetRestored: !!rec.budgetRestored,
      budgetDiscarded: !!rec.budgetDiscarded
    };
    p.meta = p.store.loadMeta() || {
      termId: p.termId || path.basename(path.resolve(dir)),
      counter: 0,
      batch: 0
    };
    if (p.termId) p.meta.termId = p.termId;
    p.ops = rec.ops;
    p.rebuild();
    // Committed budget manifest is authoritative over journaled budget ops.
    if (rec.budget) p.overlayBudget(rec.budget);
    const ownMax = Math.max(0, ...p.ops.filter((o) => o.term === p.meta.termId).map((o) => o.counter || 0));
    p.meta.counter = Math.max(p.meta.counter || 0, ownMax);
    const plan = p.store.loadPlan();
    if (plan && plan.certificate) p.certificate = plan.certificate;
    return p;
  }

  rebuild() {
    this.state = emptyState();
    for (const op of resolveOps(this.ops)) applyOpToState(this.state, op);
    this.memo = { order: new Map(), assign: new Map() };
  }

  overlayBudget(budget) {
    for (const [id, cap] of Object.entries(budget.shifts || {})) {
      if (this.state.shifts[id]) this.state.shifts[id].capacity = cap;
    }
    for (const [id, life] of Object.entries(budget.molds || {})) {
      if (this.state.molds[id]) this.state.molds[id].life = life;
    }
  }

  versionVector() {
    const vv = {};
    for (const op of this.ops) {
      vv[op.term] = Math.max(vv[op.term] || 0, op.counter || 0);
    }
    return vv;
  }

  // Change capture: journal the op, apply it, invalidate only the memo
  // entries it can affect (incremental recompute, never a full rebuild).
  op(op, data) {
    this.meta.counter += 1;
    const vv = this.versionVector();
    vv[this.meta.termId] = this.meta.counter;
    const entry = {
      opId: `${this.meta.termId}-${this.meta.counter}`,
      term: this.meta.termId,
      counter: this.meta.counter,
      batch: `${this.meta.termId}#${this.meta.batch}`,
      vv,
      op,
      data
    };
    this.store.appendOp(entry);
    this.ops.push(entry);
    applyOpToState(this.state, entry);
    this.invalidateFor(op);
    this.store.saveMeta(this.meta);
    return entry;
  }

  invalidateFor(op) {
    switch (op) {
      case 'insert':
        break; // new job: only new cache keys appear
      case 'assign':
      case 'unassign':
      case 'pend':
      case 'unpend':
        this.memo.assign.clear(); // pins changed; per-shift orderings stay valid
        break;
      default:
        this.memo.order.clear();
        this.memo.assign.clear();
    }
  }

  solveCurrent() {
    const stats = { order: 0, assign: 0 };
    const res = solve(this.state, { memo: this.memo, stats });
    res.pending = this.state.pending.slice().sort();
    if (res.feasible) {
      this.certificate = {
        planStr: res.planStr,
        cost: res.cost,
        hash: crypto.createHash('sha256').update(res.planStr).digest('hex').slice(0, 16)
      };
    }
    // On infeasibility the last feasible certificate is retained.
    res.certificate = this.certificate;
    res.stats = stats;
    return res;
  }

  plan() {
    return this.solveCurrent();
  }

  persistPlan(res) {
    this.store.savePlan({
      feasible: res.feasible,
      reason: res.reason,
      cost: res.cost,
      plan: res.plan,
      planStr: res.planStr,
      pending: res.pending,
      certificate: this.certificate
    });
  }

  apply() {
    const res = this.solveCurrent();
    this.persistPlan(res);
    this.store.commitBudget(budgetManifest(this.state));
    this.meta.batch += 1;
    this.store.saveMeta(this.meta);
    return res;
  }

  // Hierarchical rollback: whole batches are rolled back, but locked mold
  // maintenance lives at a higher preservation level and is never reverted.
  rollback(n) {
    const batches = [];
    for (const op of this.ops) {
      if (!batches.includes(op.batch)) batches.push(op.batch);
    }
    if (!Number.isInteger(n) || n < 1 || n > batches.length) {
      throw new PlanError('ROLLBACK', 6,
        `rollback depth ${n} out of bounds (${batches.length} batch(es) available)`);
    }
    const drop = new Set(batches.slice(batches.length - n));
    const kept = this.ops.filter(
      (o) => !drop.has(o.batch) || (o.op === 'maintenance' && o.data && o.data.locked)
    );
    const preserved = kept.filter((o) => drop.has(o.batch)).length;
    this.ops = kept;
    this.store.rewriteJournal(kept);
    this.rebuild();
    const res = this.solveCurrent();
    this.persistPlan(res);
    this.store.commitBudget(budgetManifest(this.state));
    this.store.saveMeta(this.meta);
    return { rolledBack: n, preservedLockedMaintenance: preserved, result: res };
  }

  // After sync: demote over-allocated pinned jobs to pending (deterministic
  // order: lowest pin stamp first) until the plan is feasible again. Pending
  // jobs are excluded from the problem, never treated as unsatisfiable.
  finishSync() {
    for (let guard = 0; guard < 1000; guard++) {
      const res = this.solveCurrent();
      if (res.feasible) return this.apply();
      const victim = this.lowestPinnedJob();
      if (!victim) return this.apply();
      this.op('pend', { job: victim });
    }
    throw new PlanError('INTERNAL', 2, 'sync demotion did not converge');
  }

  lowestPinnedJob() {
    let best = null;
    for (const [job, meta] of Object.entries(this.state.pinMeta)) {
      if (!this.state.pinned[job]) continue;
      const stamp = [meta.counter || 0, meta.term || '', job];
      if (!best || cmpStampArr(stamp, best.stamp) < 0) best = { job, stamp };
    }
    return best ? best.job : null;
  }

  verify() {
    const j = require('./journal').readOps(this.store.journalFile);
    const journalOk = !j.truncated && j.ops.length === this.ops.length;
    const budget = this.store.budgetStatus();
    const budgetOk = budget.ok;
    const res = this.solveCurrent();
    const plan = this.store.loadPlan();
    const planOk = !!plan
      && plan.feasible === res.feasible
      && (!res.feasible || plan.planStr === res.planStr);
    const checks = { journal: journalOk, budget: budgetOk, plan: planOk };
    return { ok: journalOk && budgetOk && planOk, checks, feasible: res.feasible };
  }
}

function cmpStampArr(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

module.exports = { Planner, PlanError, applyOpToState, resolveOps, budgetManifest };
