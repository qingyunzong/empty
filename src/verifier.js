// Offline linearizability verifier.
//
// Input history: { ops: [{id, cmd, start, end, args:{expect}}],
//                  events: [{id, ts, src, kind, args}], seed }
// Output verdict: LINEARIZABLE | VIOLATION | UNKNOWN.
//
// Candidate interleavings: events are ordered by ts (same-ts ties are free and
// are broken by src priority + replayable seeded randomness for the canonical
// order); an op may linearize at any point inside [start, end]; op A precedes
// op B when A.end < B.start. Command confirmation events (kind 'ack') must
// match the result computed at the op's linearization point, and every step
// must satisfy the device state machine.
//
// UNKNOWN is never conflated with VIOLATION: ops missing `end` (still pending)
// or an exhausted search budget yield UNKNOWN.
import { initialState, applyOp, applyEvent } from './machine.js';
import { randFor } from './prng.js';

export const VERDICT = Object.freeze({
  LINEARIZABLE: 'LINEARIZABLE',
  VIOLATION: 'VIOLATION',
  UNKNOWN: 'UNKNOWN',
});

class BudgetExceeded extends Error {}

const SRC_PRIORITY = { cmd: 0, plc: 1, hmi: 2, photo: 3, cyl: 4 };
const srcRank = (s) => (s in SRC_PRIORITY ? SRC_PRIORITY[s] : 99);

export function dedupEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function normalizeResult(v) {
  return v === true || v === 'ok' ? 'ok' : 'fail';
}

function expectOf(op) {
  return op.args && op.args.expect != null ? normalizeResult(op.args.expect) : 'ok';
}

function prepare(history) {
  const ops = (history.ops ?? []).map((o, i) => ({ ...o, _idx: i }));
  const events = dedupEvents(history.events ?? []);
  const opsById = new Map(ops.map((o) => [o.id, o._idx]));
  return { ops, events, opsById };
}

// --- shared stepper (used by both the search and the reference enumerator) ---

function stepOp(state, op, results) {
  const { state: next, result } = applyOp(state, op);
  if (result !== expectOf(op)) return null;
  const res = results.slice();
  res[op._idx] = result;
  return { state: next, results: res };
}

function stepEvent(state, event, results, opsById) {
  if (event.kind === 'ack') {
    const idx = opsById.get(event.args?.op);
    if (idx === undefined) return null;
    const want = normalizeResult(event.args?.ok ?? 'ok');
    if (results[idx] !== want) return null;
    return { state, results };
  }
  const r = applyEvent(state, event);
  if (!r.valid) return null;
  return { state: r.state, results };
}

// --- canonical candidate interleaving (ts, src priority, seeded tiebreak) ---

export function canonicalOrder(history) {
  const seed = history.seed ?? 0;
  const items = [];
  for (const op of history.ops ?? []) {
    items.push({ type: 'op', ref: op, ts: op.start, src: 'cmd', key: `op:${op.id}` });
  }
  for (const ev of dedupEvents(history.events ?? [])) {
    items.push({ type: 'event', ref: ev, ts: ev.ts, src: ev.src, key: `ev:${ev.id}` });
  }
  items.sort(
    (a, b) =>
      a.ts - b.ts ||
      srcRank(a.src) - srcRank(b.src) ||
      randFor(seed, a.key) - randFor(seed, b.key) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return items;
}

// Project a list of canonical items back to a history, dropping ack events
// whose command is not in the projection.
export function projectItems(items, seed = 0) {
  const ops = items.filter((i) => i.type === 'op').map((i) => i.ref);
  const opIds = new Set(ops.map((o) => o.id));
  const events = items
    .filter((i) => i.type === 'event')
    .map((i) => i.ref)
    .filter((e) => e.kind !== 'ack' || opIds.has(e.args?.op));
  return { ops, events, seed };
}

// --- main verifier: backtracking with memoization ---

export function searchLinearizable(history, { maxNodes = 200000 } = {}) {
  const { ops, events, opsById } = prepare(history);
  const m = ops.length;
  const evSorted = events
    .slice()
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const k = evSorted.length;
  const evTs = evSorted.map((e) => e.ts);
  const fullEv = (1n << BigInt(k)) - 1n;
  const fullOp = (1n << BigInt(m)) - 1n;
  let nodes = 0;
  const memo = new Set();
  const stateKey = (s) => `${s.estop ? 1 : 0}${s.photo ? 1 : 0}${s.cyl}`;

  function search(evMask, opMask, state, results, lastEvTs) {
    if (evMask === fullEv && opMask === fullOp) return true;
    if (++nodes > maxNodes) throw new BudgetExceeded('search node budget exceeded');
    const key = `${evMask}|${opMask}|${stateKey(state)}|${results.map((r) => r?.[0] ?? '.').join('')}`;
    if (memo.has(key)) return false;

    let minEvTs = Infinity;
    for (let i = 0; i < k; i++) {
      if (!((evMask >> BigInt(i)) & 1n) && evTs[i] < minEvTs) minEvTs = evTs[i];
    }

    // Place an event: must be in the earliest unplaced ts group, and every op
    // whose window closed before it (end < ts) must already be placed.
    for (let i = 0; i < k; i++) {
      const bit = 1n << BigInt(i);
      if ((evMask & bit) !== 0n || evTs[i] !== minEvTs) continue;
      let blocked = false;
      for (const o of ops) {
        if (!((opMask >> BigInt(o._idx)) & 1n) && o.end < evTs[i]) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const r = stepEvent(state, evSorted[i], results, opsById);
      if (r && search(evMask | bit, opMask, r.state, r.results, evTs[i])) return true;
    }

    // Place an op: all earlier events (ts < start) and all real-time-preceding
    // ops must be placed, and no event past its window (ts > end) may be placed.
    for (const o of ops) {
      const bit = 1n << BigInt(o._idx);
      if ((opMask & bit) !== 0n) continue;
      if (minEvTs < o.start) continue;
      if (lastEvTs > o.end) continue;
      let blocked = false;
      for (const p of ops) {
        if (p._idx !== o._idx && !((opMask >> BigInt(p._idx)) & 1n) && p.end < o.start) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const r = stepOp(state, o, results);
      if (r && search(evMask, opMask | bit, r.state, r.results, lastEvTs)) return true;
    }

    memo.add(key);
    return false;
  }

  return search(0n, 0n, initialState(), new Array(m).fill(undefined), -Infinity);
}

// --- exponential reference enumeration: all permutations, filter, simulate ---

export function referenceLinearizable(history) {
  const { ops, events, opsById } = prepare(history);
  const items = [
    ...ops.map((o) => ({ type: 'op', op: o })),
    ...events.map((e) => ({ type: 'event', event: e })),
  ];
  const n = items.length;
  const used = new Array(n).fill(false);
  const order = [];

  function validOrder(ord) {
    const pos = new Map(ord.map((itemIdx, p) => [itemIdx, p]));
    let lastEvTs = -Infinity;
    for (const idx of ord) {
      const it = items[idx];
      if (it.type === 'event') {
        if (it.event.ts < lastEvTs) return false;
        lastEvTs = it.event.ts;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = items[i];
      if (a.type !== 'op') continue;
      for (let j = 0; j < n; j++) {
        const b = items[j];
        if (b.type === 'event') {
          if (b.event.ts < a.op.start && pos.get(j) > pos.get(i)) return false;
          if (b.event.ts > a.op.end && pos.get(j) < pos.get(i)) return false;
        } else if (i !== j && a.op.end < b.op.start && pos.get(i) > pos.get(j)) {
          return false;
        }
      }
    }
    return true;
  }

  function simulate(ord) {
    let state = initialState();
    let results = new Array(ops.length).fill(undefined);
    for (const idx of ord) {
      const it = items[idx];
      const r =
        it.type === 'op'
          ? stepOp(state, it.op, results)
          : stepEvent(state, it.event, results, opsById);
      if (!r) return false;
      state = r.state;
      results = r.results;
    }
    return true;
  }

  function enumerate() {
    if (order.length === n) return validOrder(order) && simulate(order);
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      order.push(i);
      if (enumerate()) return true;
      order.pop();
      used[i] = false;
    }
    return false;
  }

  return enumerate();
}

// --- verdict ---

export function check(history, opts = {}) {
  const ops = history.ops ?? [];
  if (ops.some((o) => o.end == null)) {
    return { verdict: VERDICT.UNKNOWN, reason: 'pending-op' };
  }
  try {
    const ok = searchLinearizable(history, opts);
    return { verdict: ok ? VERDICT.LINEARIZABLE : VERDICT.VIOLATION };
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      return { verdict: VERDICT.UNKNOWN, reason: 'budget-exceeded' };
    }
    throw err;
  }
}

// --- minimal violating prefix over the canonical candidate interleaving ---

export function findMinimalPrefix(history) {
  const items = canonicalOrder(history);
  for (let len = 1; len <= items.length; len++) {
    const sub = projectItems(items.slice(0, len), history.seed ?? 0);
    if (check(sub).verdict === VERDICT.VIOLATION) {
      return { length: len, items: items.slice(0, len), history: sub };
    }
  }
  return null;
}

// --- minimal certificate: 1-minimal subset that is still a violation ---
// Deleting any single remaining item makes the history pass.

export function findMinimalCertificate(history) {
  if (check(history).verdict !== VERDICT.VIOLATION) return null;
  const seed = history.seed ?? 0;
  let current = canonicalOrder(history);
  let improved = true;
  while (improved) {
    improved = false;
    for (const item of current) {
      const candidate = current.filter((x) => x !== item);
      if (check(projectItems(candidate, seed)).verdict === VERDICT.VIOLATION) {
        current = candidate;
        improved = true;
      }
    }
  }
  return { items: current, history: projectItems(current, seed) };
}
