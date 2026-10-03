'use strict';

// Core scheduling primitives.
//
// Model:
// - A pass transmits from its (possibly weather-corrected) window start for
//   txLen = ceil(bytes / rate) seconds, where bytes = min(rate * windowLen, onboard).
// - Two transmissions must be separated by `setup` seconds (antenna switch
//   settle time): next.start >= prev.start + prev.txLen + setup.
// - Selection maximizes total effective bytes via exact DP (weighted interval
//   scheduling). Ties break by deficit-weighted bytes, then lexicographically
//   by (taskId, start, passId) so equal-deficit contenders resolve by task ID
//   and start second.
// - Confirmed (locked) segments are never preempted; other passes must avoid
//   them (including the setup gap). Preemption is only possible in unlocked
//   time and always preserves already-transmitted bytes.
// - Task daily quota caps allocation; allocation happens in fairness order
//   (deficit desc, taskId asc, start asc).

function passPotential(pass) {
  const len = pass.window.end - pass.window.start;
  return Math.max(0, Math.min(pass.rate * len, pass.onboard));
}

function txLenFor(bytes, rate) {
  return Math.ceil(bytes / rate);
}

// Fairness comparator: deficit desc, then taskId asc, then start asc, then id.
function fairCompare(a, b, deficits) {
  const da = deficits[a.taskId] || 0;
  const db = deficits[b.taskId] || 0;
  if (da !== db) return db - da;
  if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
  if (a.start !== b.start) return a.start - b.start;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function solutionKey(c) {
  return c.taskId + '' + String(c.start).padStart(15, '0') + '' + c.id;
}

// Returns the preferred of two solutions: more bytes, then more
// deficit-satisfying bytes, then lexicographically smaller key sequence.
function better(a, b) {
  if (a.bytes !== b.bytes) return a.bytes > b.bytes ? a : b;
  if (a.deficitBytes !== b.deficitBytes) return a.deficitBytes > b.deficitBytes ? a : b;
  const ka = a.keys;
  const kb = b.keys;
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i++) {
    if (ka[i] !== kb[i]) return ka[i] < kb[i] ? a : b;
  }
  return ka.length <= kb.length ? a : b;
}

function computeSchedule(state, opts = {}) {
  const setup = opts.setup !== undefined ? opts.setup : (state.config.setup || 0);
  const tasks = state.tasks || {};
  const passes = Object.values(state.passes || {});

  const delivered = {};
  const locked = [];
  const assignments = {};
  const loss = { weather: 0, conflict: 0, quota: 0, pending: 0, byPass: {} };

  for (const p of passes) {
    if (p.confirmed && p.confirmed.bytes > 0) {
      locked.push({ start: p.confirmed.start, end: p.confirmed.start + p.confirmed.txLen });
      assignments[p.id] = {
        task: p.taskId, start: p.confirmed.start, txLen: p.confirmed.txLen,
        bytes: p.confirmed.bytes, locked: true,
      };
      delivered[p.taskId] = (delivered[p.taskId] || 0) + p.confirmed.bytes;
    }
  }

  const deficits = {};
  for (const t of Object.keys(tasks)) {
    deficits[t] = Math.max(0, (tasks[t].min || 0) - (delivered[t] || 0));
  }

  const candidates = [];
  for (const p of passes) {
    if (p.confirmed && p.confirmed.bytes > 0) continue;
    const potential = passPotential(p);
    if (p.drop) {
      const key = p.drop.pending ? 'pending' : p.drop.reason;
      loss[key] += potential;
      loss.byPass[p.id] = { reason: key, bytes: potential };
      continue;
    }
    if (potential <= 0) continue;
    const txLen = txLenFor(potential, p.rate);
    const start = p.window.start;
    const blocked = locked.some((iv) => !(start >= iv.end + setup || start + txLen <= iv.start - setup));
    if (blocked) {
      loss.conflict += potential;
      loss.byPass[p.id] = { reason: 'conflict', bytes: potential };
      continue;
    }
    candidates.push({ id: p.id, taskId: p.taskId, rate: p.rate, start, potential, txLen });
  }

  candidates.sort((a, b) =>
    a.start - b.start ||
    (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = candidates.length;
  const next = new Array(n).fill(n);
  for (let i = 0; i < n; i++) {
    const end = candidates[i].start + candidates[i].txLen + setup;
    let lo = i + 1;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[mid].start >= end) hi = mid; else lo = mid + 1;
    }
    next[i] = lo;
  }

  const keys = candidates.map(solutionKey);
  const best = new Array(n + 1);
  best[n] = { bytes: 0, deficitBytes: 0, keys: [] };
  for (let i = n - 1; i >= 0; i--) {
    const skip = best[i + 1];
    const sub = best[next[i]];
    const take = {
      bytes: candidates[i].potential + sub.bytes,
      deficitBytes: Math.min(candidates[i].potential, deficits[candidates[i].taskId] || 0) + sub.deficitBytes,
      keys: [keys[i], ...sub.keys],
    };
    best[i] = better(take, skip);
  }

  const chosenKeys = new Set(best[0].keys);
  const selected = candidates.filter((c, i) => chosenKeys.has(keys[i]));

  // Quota allocation in fairness order (deficit desc, taskId, start).
  const deficitsNow = { ...deficits };
  const quotaLeft = {};
  for (const t of Object.keys(tasks)) quotaLeft[t] = tasks[t].quota === undefined ? Infinity : tasks[t].quota;
  const ordered = [...selected].sort((a, b) => fairCompare(a, b, deficitsNow));
  const alloc = {};
  for (const c of ordered) {
    const q = quotaLeft[c.taskId] === undefined ? Infinity : quotaLeft[c.taskId];
    const a = Math.min(c.potential, q);
    alloc[c.id] = a;
    quotaLeft[c.taskId] = q - a;
    deficitsNow[c.taskId] = Math.max(0, (deficitsNow[c.taskId] || 0) - a);
  }

  let totalBytes = 0;
  const timeline = [];
  for (const c of selected) {
    const a = alloc[c.id];
    if (a < c.potential) {
      loss.quota += c.potential - a;
      loss.byPass[c.id] = { reason: 'quota', bytes: c.potential - a };
    }
    if (a <= 0) continue;
    const txLen = txLenFor(a, c.rate);
    assignments[c.id] = { task: c.taskId, start: c.start, txLen, bytes: a, locked: false };
    totalBytes += a;
    let remaining = a;
    for (let sec = c.start; sec < c.start + txLen; sec++) {
      const b = Math.min(c.rate, remaining);
      timeline.push({ sec, pass: c.id, task: c.taskId, bytes: b });
      remaining -= b;
    }
  }

  for (let i = 0; i < n; i++) {
    if (!chosenKeys.has(keys[i])) {
      loss.conflict += candidates[i].potential;
      loss.byPass[candidates[i].id] = { reason: 'conflict', bytes: candidates[i].potential };
    }
  }

  for (const p of passes) {
    if (p.confirmed && p.confirmed.bytes > 0) {
      totalBytes += p.confirmed.bytes;
      let remaining = p.confirmed.bytes;
      for (let sec = p.confirmed.start; sec < p.confirmed.start + p.confirmed.txLen; sec++) {
        const b = Math.min(p.rate, remaining);
        timeline.push({ sec, pass: p.id, task: p.taskId, bytes: b, locked: true });
        remaining -= b;
      }
    }
  }

  timeline.sort((a, b) => a.sec - b.sec || (a.pass < b.pass ? -1 : a.pass > b.pass ? 1 : 0));

  return { totalBytes, timeline, assignments, loss, deficits, setup };
}

function bytesPerTask(result) {
  const per = {};
  for (const a of Object.values(result.assignments)) {
    per[a.task] = (per[a.task] || 0) + a.bytes;
  }
  return per;
}

module.exports = { computeSchedule, fairCompare, passPotential, txLenFor, bytesPerTask };
