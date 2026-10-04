import { applyEvent, foldEvents } from './state.js';
import { effectivePermission } from './config.js';

export function isReleasable(idx, state, orderId) {
  const order = state.orders[orderId];
  if (!order || order.decision !== 'released') return false;
  if (effectivePermission(idx, orderId) !== 'allow') return false;
  const spec = idx.orders.get(orderId);
  return Object.entries(spec.materials).every(
    ([m, q]) => (order.locks[m] ?? 0) >= q,
  );
}

function candidates(state, orderId) {
  const t = state.lastTs ?? 0;
  const out = [];
  for (const priority of [0, 1, 2]) {
    out.push({ ts: t + 60000, type: 'freeze', order: orderId, priority, actor: 'planner' });
  }
  // Same-instant freeze: tie-break still makes it win over a release.
  out.push({ ts: t, type: 'freeze', order: orderId, priority: 0, actor: 'planner' });
  return out;
}

// BFS for the shortest appended event sequence that flips the order from
// releasable to non-releasable. Returns null if the order is not releasable
// in the base state, or no sequence within maxDepth works.
export function findCounterexample(idx, events, orderId, maxDepth = 3) {
  const base = foldEvents(events, idx);
  if (!isReleasable(idx, base, orderId)) return null;
  let frontier = [{ state: base, path: [] }];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const cand of candidates(node.state, orderId)) {
        const state = structuredClone(node.state);
        const event = { ...cand, seq: state.seq + 1 };
        applyEvent(state, event, idx);
        const path = [...node.path, event];
        if (!isReleasable(idx, state, orderId)) {
          return { order: orderId, sequence: path, reason: 'order becomes non-releasable' };
        }
        next.push({ state, path });
      }
    }
    frontier = next;
  }
  return null;
}
