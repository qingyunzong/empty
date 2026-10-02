import { canonicalOrder } from './interleave.js';
import { INITIAL_STATE, COMMANDS } from './machine.js';
import { VERDICT } from './verify.js';

// Exponential reference enumerator: naively enumerates every op permutation
// (filtered by real-time precedence) x every injective ack assignment.
// No memoization, no pruning beyond the spec itself. Ground truth for tests.
export function referenceLinearizable(ops, acks) {
  const n = ops.length;
  const usedOp = new Array(n).fill(false);
  const usedAck = new Array(acks.length).fill(false);
  function place(count, state) {
    if (count === n) return true;
    for (let i = 0; i < n; i++) {
      if (usedOp[i]) continue;
      let ready = true;
      for (let j = 0; j < n; j++) {
        if (j !== i && !usedOp[j] && ops[j].end <= ops[i].start) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      const spec = COMMANDS[ops[i].cmd];
      if (!spec || !spec.enabled(state)) continue;
      for (let a = 0; a < acks.length; a++) {
        if (usedAck[a]) continue;
        if (acks[a].kind !== spec.ack) continue;
        if (acks[a].ts < ops[i].start || acks[a].ts > ops[i].end) continue;
        usedOp[i] = true;
        usedAck[a] = true;
        if (place(count + 1, spec.next(state))) return true;
        usedOp[i] = false;
        usedAck[a] = false;
      }
    }
    return false;
  }
  return place(0, INITIAL_STATE);
}

// Reference verdict, mirroring verify() semantics with the naive enumerator:
// missing ack evidence => UNKNOWN, never VIOLATION.
export function referenceVerdict(history) {
  const ops = history.ops ?? [];
  const events = history.events ?? [];
  const seed = history.seed ?? 0;
  const completed = ops.filter((o) => o.end != null);
  const acks = canonicalOrder(
    events.filter((e) => e.kind !== 'injection'),
    seed,
  );
  if (referenceLinearizable(completed, acks)) {
    return completed.length === ops.length
      ? VERDICT.LINEARIZABLE
      : VERDICT.UNKNOWN;
  }
  const fullyConfirmed = completed.every((op) => {
    const spec = COMMANDS[op.cmd];
    return (
      spec &&
      acks.some(
        (e) => e.kind === spec.ack && e.ts >= op.start && e.ts <= op.end,
      )
    );
  });
  return fullyConfirmed ? VERDICT.VIOLATION : VERDICT.UNKNOWN;
}
