'use strict';

const { planTarget, chargeOf } = require('./planner');

// Discrete-event list scheduler on a single machine.
// - A node is runnable when pending, inside the planned target set, all deps
//   done, and its remaining quota charge fits the owner's budget.
// - Among runnable nodes that fit free cpu/mem, pick the smallest fairness
//   key: ownerCompletedBytes - agingRate * waitTime (aging prevents
//   starvation of long-waiting nodes).
// - Failures are retried up to maxRetries; preemption only interrupts
//   recomputable running nodes and keeps materialized evidence untouched.
function runSchedule(engine, opts = {}) {
  const state = engine.state;
  const agingRate = opts.agingRate ?? 1;
  const maxRetries = opts.maxRetries ?? 3;
  const preemptIds = new Set(opts.preempt ?? []);
  const target = planTarget(state, { maxRetries });

  const nodes = state.nodes;
  const events = [];
  let t = 0;
  let usedCpu = 0;
  let usedMem = 0;
  const running = new Map(); // id -> { end, preemptAt }
  const readySince = new Map();
  const attempts = new Map();
  const preemptedOnce = new Set();

  const remaining = (owner) =>
    (state.quotas[owner] ?? Infinity) - (state.completedBytes[owner] ?? 0);
  const depsDone = (n) => n.deps.every((d) => nodes[d].status === 'done');
  const isCandidate = (n) =>
    n.status === 'pending' &&
    (target === null || target.has(n.id)) &&
    depsDone(n) &&
    chargeOf(state, n) <= remaining(n.owner);
  const fairnessKey = (n) =>
    (state.completedBytes[n.owner] ?? 0) - agingRate * (t - (readySince.get(n.id) ?? t));

  for (let guard = 0; guard < 100000; guard += 1) {
    for (const n of Object.values(nodes)) {
      if (n.status === 'failed' && (attempts.get(n.id) ?? 0) < maxRetries) {
        n.status = 'pending';
      }
    }
    for (const n of Object.values(nodes)) {
      if (isCandidate(n)) {
        if (!readySince.has(n.id)) readySince.set(n.id, t);
      } else {
        readySince.delete(n.id);
      }
    }

    for (;;) {
      const cands = Object.values(nodes).filter(
        (n) =>
          isCandidate(n) &&
          n.cpu <= state.machine.cpus - usedCpu &&
          n.mem <= state.machine.mem - usedMem,
      );
      if (cands.length === 0) break;
      cands.sort((a, b) => {
        const ka = fairnessKey(a);
        const kb = fairnessKey(b);
        if (ka !== kb) return ka - kb;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      const n = cands[0];
      n.status = 'running';
      usedCpu += n.cpu;
      usedMem += n.mem;
      const cost = Math.max(n.cost, 0);
      const end = t + cost;
      let preemptAt = null;
      if (preemptIds.has(n.id) && !preemptedOnce.has(n.id) && cost >= 2) {
        preemptAt = t + Math.max(1, Math.floor(cost / 2));
      }
      running.set(n.id, { end, preemptAt });
      events.push({ time: t, type: 'start', node: n.id, owner: n.owner });
      readySince.delete(n.id);
    }

    if (running.size === 0) break;

    let nextT = Infinity;
    for (const r of running.values()) {
      if (r.preemptAt != null) nextT = Math.min(nextT, r.preemptAt);
      nextT = Math.min(nextT, r.end);
    }
    t = nextT;

    for (const [id, r] of [...running]) {
      if (r.preemptAt != null && r.preemptAt <= t && r.end > t) {
        const n = nodes[id];
        running.delete(id);
        usedCpu -= n.cpu;
        usedMem -= n.mem;
        preemptedOnce.add(id);
        engine.preempt(id); // validates recomputable, back to pending
        events.push({ time: t, type: 'preempt', node: id, owner: n.owner });
      }
    }

    for (const [id, r] of [...running]) {
      if (r.end > t) continue;
      const n = nodes[id];
      running.delete(id);
      usedCpu -= n.cpu;
      usedMem -= n.mem;
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if ((n.fails ?? 0) >= attempt) {
        n.status = 'failed';
        events.push({ time: t, type: 'fail', node: id, owner: n.owner, attempt });
      } else {
        n.status = 'done';
        if (state.ledger[id] == null) {
          state.ledger[id] = n.bytes;
          state.completedBytes[n.owner] = (state.completedBytes[n.owner] ?? 0) + n.bytes;
        }
        events.push({ time: t, type: 'end', node: id, owner: n.owner, attempt });
      }
    }
  }

  const completed = Object.values(nodes)
    .filter((n) => n.status === 'done')
    .map((n) => n.id)
    .sort();
  return { events, completed, time: t };
}

module.exports = { runSchedule };
