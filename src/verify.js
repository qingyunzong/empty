import { canonicalOrder } from './interleave.js';
import { INITIAL_STATE, COMMANDS } from './machine.js';

export const VERDICT = {
  LINEARIZABLE: 'LINEARIZABLE',
  VIOLATION: 'VIOLATION',
  UNKNOWN: 'UNKNOWN',
};

function ackEventsOf(events, seed) {
  return canonicalOrder(
    events.filter((e) => e.kind !== 'injection'),
    seed,
  );
}

// In-interval ack candidates for each op, in canonical (seeded) event order.
function ackCandidates(ops, acks) {
  return ops.map((op) => {
    const spec = COMMANDS[op.cmd];
    if (!spec) return [];
    const list = [];
    acks.forEach((e, idx) => {
      if (e.kind === spec.ack && e.ts >= op.start && e.ts <= op.end) {
        list.push(idx);
      }
    });
    return list;
  });
}

// Core search: is there an interleaving of `ops` that
//   - respects real-time order (op_i.end <= op_j.start  =>  i before j),
//   - respects the device state machine, and
//   - pairs every op with a distinct ack event of the right kind whose
//     timestamp falls inside the op's [start, end] interval?
// Memoized DFS over (done ops, used acks, machine state). Returns the witness
// list [{op, ack}] or null.
export function searchLinearization(ops, acks) {
  const n = ops.length;
  const prereq = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && ops[i].end <= ops[j].start) prereq[j] |= 1 << i;
    }
  }
  const candidates = ackCandidates(ops, acks);
  const full = (1 << n) - 1;
  const memo = new Map();
  function dfs(done, used, state) {
    if (done === full) return [];
    const key = `${done}|${used}|${state}`;
    if (memo.has(key)) return memo.get(key);
    let result = null;
    for (let i = 0; i < n && result === null; i++) {
      if (done & (1 << i)) continue;
      if ((prereq[i] & ~done) !== 0) continue;
      const spec = COMMANDS[ops[i].cmd];
      if (!spec || !spec.enabled(state)) continue;
      for (const a of candidates[i]) {
        if (used & (1 << a)) continue;
        const rest = dfs(done | (1 << i), used | (1 << a), spec.next(state));
        if (rest !== null) {
          result = [{ op: i, ack: a }, ...rest];
          break;
        }
      }
    }
    memo.set(key, result);
    return result;
  }
  return dfs(0, 0, INITIAL_STATE);
}

// Three-valued classification of a set of completed ops against ack events:
//   LINEARIZABLE - a legal interleaving exists
//   VIOLATION    - every op carries positive confirmation (an in-interval ack
//                  candidate), yet no legal interleaving exists: the log is
//                  definitively inconsistent
//   UNKNOWN      - evidence is insufficient (some op has no in-interval ack);
//                  a missing confirmation is NOT a violation
function classifyCompleted(ops, acks) {
  if (ops.length === 0) return VERDICT.LINEARIZABLE;
  if (searchLinearization(ops, acks) !== null) return VERDICT.LINEARIZABLE;
  const candidates = ackCandidates(ops, acks);
  const fullyConfirmed = ops.every(
    (op, i) => COMMANDS[op.cmd] && candidates[i].length > 0,
  );
  return fullyConfirmed ? VERDICT.VIOLATION : VERDICT.UNKNOWN;
}

function isViolation(ops, events, seed) {
  const completed = ops.filter((o) => o.end != null);
  return classifyCompleted(completed, ackEventsOf(events, seed)) === VERDICT.VIOLATION;
}

// Canonical timeline of history items: ops enter at their start ts, events at
// their ts; ties resolved by src priority + seeded shuffle (same rule as the
// replayer, ops are attributed to the 'plc' source).
function canonicalItems(history) {
  const seed = history.seed ?? 0;
  const items = [
    ...history.ops.map((op, i) => ({
      key: { id: `op#${i}`, ts: op.start, src: 'plc' },
      type: 'op',
      op,
    })),
    ...history.events.map((event) => ({ key: event, type: 'event', event })),
  ];
  const byRef = new Map(items.map((it) => [it.key, it]));
  return canonicalOrder(
    items.map((it) => it.key),
    seed,
  ).map((k) => byRef.get(k));
}

// Smallest prefix of the canonical timeline that is already a violation.
export function minimalPrefix(history) {
  const seed = history.seed ?? 0;
  const items = canonicalItems(history);
  for (let k = 1; k <= items.length; k++) {
    const slice = items.slice(0, k);
    const ops = slice.filter((i) => i.type === 'op').map((i) => i.op);
    const events = slice.filter((i) => i.type === 'event').map((i) => i.event);
    if (ops.length > 0 && isViolation(ops, events, seed)) {
      return { length: k, items: slice };
    }
  }
  return null;
}

// Minimal certificate: a 1-minimal set of history items that still violates.
// Removing ANY single item from it makes the history pass (not VIOLATION).
// Computed by greedy removal iterated to a fixpoint.
export function minimalCertificate(history) {
  const seed = history.seed ?? 0;
  let current = canonicalItems(history);
  const violates = (set) =>
    isViolation(
      set.filter((i) => i.type === 'op').map((i) => i.op),
      set.filter((i) => i.type === 'event').map((i) => i.event),
      seed,
    );
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i++) {
      const trial = current.slice(0, i).concat(current.slice(i + 1));
      if (violates(trial)) {
        current = trial;
        changed = true;
        break;
      }
    }
  }
  return { items: current, minimal: true };
}

// Verdict semantics:
//   - completed ops definitively conflict => VIOLATION (pending ops can't fix it)
//   - otherwise, ops without end or missing ack evidence => UNKNOWN
//   - everything completed and linearizable => LINEARIZABLE
// UNKNOWN is evidence of ignorance, never reported as a violation.
export function verify(history) {
  const ops = history.ops ?? [];
  const events = history.events ?? [];
  const seed = history.seed ?? 0;
  const acks = ackEventsOf(events, seed);
  const completed = ops.filter((o) => o.end != null);
  const pending = ops.length - completed.length;
  const verdict = classifyCompleted(completed, acks);
  if (verdict === VERDICT.LINEARIZABLE) {
    if (pending > 0) {
      return {
        verdict: VERDICT.UNKNOWN,
        reason: `${pending} operation(s) missing end`,
        pending,
      };
    }
    const witness = searchLinearization(completed, acks);
    return {
      verdict: VERDICT.LINEARIZABLE,
      witness: witness.map((w) => ({ op: completed[w.op], ack: acks[w.ack] })),
    };
  }
  if (verdict === VERDICT.UNKNOWN) {
    return {
      verdict: VERDICT.UNKNOWN,
      reason: 'insufficient ack evidence for completed operation(s)',
      pending,
    };
  }
  return {
    verdict: VERDICT.VIOLATION,
    prefix: minimalPrefix({ ops, events, seed }),
    certificate: minimalCertificate({ ops, events, seed }),
  };
}
