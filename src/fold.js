import { compare } from './clock.js';
import { initialDyn } from './model.js';

const RANK = { insert: 1, move: 2, cancel: 3 };

export function resolveConflict(a, b) {
  if (RANK[a.type] !== RANK[b.type]) return RANK[a.type] > RANK[b.type] ? a : b;
  if (a.node !== b.node) return a.node > b.node ? a : b;
  return a.seq >= b.seq ? a : b;
}

export function sortEntries(entries) {
  return [...entries].sort((x, y) => x.seq - y.seq || (x.node < y.node ? -1 : x.node > y.node ? 1 : 0));
}

const opOf = (e) => (e.type === 'insert' ? e.op.id : e.op);
const brief = (e) => ({ node: e.node, seq: e.seq, type: e.type, hash: e.hash });

function place(dyn, id, machine, index) {
  const list = dyn.order[machine] ?? (dyn.order[machine] = []);
  const i = Math.max(0, Math.min(index ?? list.length, list.length));
  list.splice(i, 0, id);
}

function removeEverywhere(dyn, id) {
  for (const list of Object.values(dyn.order)) {
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
  }
}

export function applyToDyn(dyn, e) {
  if (e.type === 'insert') {
    dyn.addedOps = dyn.addedOps.filter((o) => o.id !== e.op.id);
    dyn.addedOps.push({ id: e.op.id, job: e.op.job, cap: e.op.cap, dur: e.op.dur });
    dyn.cancelled = dyn.cancelled.filter((c) => c !== e.op.id);
    removeEverywhere(dyn, e.op.id);
    place(dyn, e.op.id, e.machine, e.index);
  } else if (e.type === 'move') {
    dyn.cancelled = dyn.cancelled.filter((c) => c !== e.op);
    removeEverywhere(dyn, e.op);
    place(dyn, e.op, e.machine, e.index);
  } else if (e.type === 'cancel') {
    removeEverywhere(dyn, e.op);
    if (!dyn.cancelled.includes(e.op)) dyn.cancelled.push(e.op);
  }
}

export function fold(plan, entries) {
  const sorted = sortEntries(entries);
  const groups = new Map();
  for (const e of sorted) {
    const key = opOf(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const winners = new Map();
  const pending = [];
  for (const [op, list] of groups) {
    let w = list[0];
    for (const e of list.slice(1)) {
      const rel = compare(w.clock, e.clock);
      if (rel === 'concurrent') w = resolveConflict(w, e);
      else if (rel === -1 || rel === 0) w = e;
    }
    winners.set(op, w);
    for (const e of list) {
      if (e !== w && compare(e.clock, w.clock) === 'concurrent') {
        pending.push({ op, reason: `concurrent-${e.type}`, loser: brief(e), winner: brief(w) });
      }
    }
  }
  pending.sort((a, b) =>
    a.op < b.op ? -1 : a.op > b.op ? 1
      : a.loser.node < b.loser.node ? -1 : a.loser.node > b.loser.node ? 1
        : a.loser.seq - b.loser.seq);
  const dyn = initialDyn(plan);
  for (const e of sorted) {
    if (winners.get(opOf(e)) === e) applyToDyn(dyn, e);
  }
  return { dyn, pending };
}
