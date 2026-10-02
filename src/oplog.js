// Append-only operation log with causal conflict resolution and undo points.
import { compareClocks, causalKeyCompare } from "./clock.js";

// Replay the log up to an effective point (latest undo target, or log end).
// Conflict rule: two *concurrent* insert ops requiring the same mold conflict;
// only the causally earlier one (deterministic causal key order) is kept, the
// loser is superseded. Causally ordered inserts never conflict.
export function replayOps(ops, pointOverride) {
  let point = pointOverride;
  if (point === undefined) {
    point = ops.length ? ops[ops.length - 1].seq : -1;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].kind === "undo") {
        point = ops[i].toSeq;
        break;
      }
    }
  }
  let base = null;
  const inserts = [];
  for (const op of ops) {
    if (op.seq > point) continue;
    if (op.kind === "load") base = op.input;
    else if (op.kind === "insert") inserts.push(op);
  }

  const superseded = new Set();
  const conflicts = [];
  for (let i = 0; i < inserts.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = inserts[j];
      const b = inserts[i];
      if (superseded.has(a.id) || superseded.has(b.id)) continue;
      if (a.order.mold !== b.order.mold) continue;
      const rel = compareClocks(a.clock, b.clock);
      if (rel === -1 || rel === 1) continue; // causally ordered: both kept
      const loser = causalKeyCompare(a, b) <= 0 ? b : a;
      const winner = loser === a ? b : a;
      superseded.add(loser.id);
      conflicts.push({ winner: winner.id, loser: loser.id, mold: a.order.mold });
    }
  }
  const effectiveInserts = inserts.filter((o) => !superseded.has(o.id));
  return { point, base, inserts, effectiveInserts, superseded, conflicts };
}

export function buildInstance(base, effectiveInserts) {
  const orders = { ...base.orders };
  for (const op of effectiveInserts) orders[op.order.id] = op.order;
  return { ...base, orders, orderIds: Object.keys(orders).sort() };
}
