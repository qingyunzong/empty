import { happensBefore } from './clock.js';

export class UnknownMemberError extends Error {
  constructor(member, eventId) {
    super(`unknown member "${member}" (event "${eventId}")`);
    this.name = 'UnknownMemberError';
    this.member = member;
    this.eventId = eventId;
    this.exitCode = 4;
  }
}

function tieBreakCompare(a, b) {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  if (a.member !== b.member) return a.member < b.member ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function canonicalOrder(events) {
  const remaining = new Set(events);
  const ordered = [];
  while (remaining.size > 0) {
    let best = null;
    for (const candidate of remaining) {
      let dominated = false;
      for (const other of remaining) {
        if (other !== candidate && happensBefore(other.clock, candidate.clock)) {
          dominated = true;
          break;
        }
      }
      if (!dominated && (best === null || tieBreakCompare(candidate, best) < 0)) {
        best = candidate;
      }
    }
    remaining.delete(best);
    ordered.push(best);
  }
  return ordered;
}

export function resolveWinner(candidates) {
  if (candidates.length === 1) return candidates[0];
  const maxEpoch = Math.max(...candidates.map((e) => e.epoch));
  let pool = candidates.filter((e) => e.epoch === maxEpoch);
  pool = pool.filter((e) => !pool.some((o) => o !== e && happensBefore(e.clock, o.clock)));
  let best = pool[0];
  for (const e of pool) {
    if (e.id > best.id) best = e;
  }
  return best;
}

export function mergeEvents(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const e of list) {
      const existing = byId.get(e.id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(e)) {
          throw new Error(`conflicting payloads for event id "${e.id}"`);
        }
      } else {
        byId.set(e.id, e);
      }
    }
  }
  return [...byId.values()];
}

export function replay(events) {
  const ordered = canonicalOrder(events);
  const members = new Map();
  const rejected = [];
  const applied = [];
  const keyEvents = new Map();
  let interlocked = false;

  for (const e of ordered) {
    if (e.type === 'join') {
      const m = members.get(e.member);
      if (m && m.joined) {
        rejected.push({ id: e.id, reason: 'already-joined' });
        continue;
      }
      const expected = (m ? m.epoch : 0) + 1;
      if (e.epoch !== expected) {
        rejected.push({ id: e.id, reason: 'bad-epoch' });
        continue;
      }
      members.set(e.member, { epoch: e.epoch, joined: true });
      applied.push(e.id);
      continue;
    }
    const m = members.get(e.member);
    if (!m) throw new UnknownMemberError(e.member, e.id);
    if (!m.joined || e.epoch !== m.epoch) {
      rejected.push({ id: e.id, reason: 'fenced' });
      continue;
    }
    if (e.type === 'leave') {
      m.joined = false;
    } else if (e.type === 'interlock') {
      interlocked = true;
    } else if (e.type === 'reset') {
      interlocked = false;
    } else {
      if (!keyEvents.has(e.key)) keyEvents.set(e.key, { bypass: [], unbypass: [] });
      keyEvents.get(e.key)[e.type].push(e);
    }
    applied.push(e.id);
  }

  const keys = {};
  const activeBypasses = [];
  for (const [key, lists] of [...keyEvents.entries()].sort()) {
    const winner = resolveWinner([...lists.bypass, ...lists.unbypass]);
    const active = winner.type === 'bypass';
    keys[key] = { state: active ? 'bypassed' : 'tombstoned', winner: winner.id };
    if (active) activeBypasses.push(key);
  }

  const valve = !interlocked ? 'OPEN' : activeBypasses.length > 0 ? 'BYPASSED' : 'CLOSED';

  return {
    valve,
    interlocked,
    activeBypasses,
    keys,
    members: Object.fromEntries([...members.entries()].sort()),
    applied,
    rejected,
    order: ordered.map((e) => e.id),
  };
}
