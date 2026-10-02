import { ExitError, EXIT } from './errors.js';

// Build id -> event index and validate that every referenced parent exists.
// Events arrive out of order (offline sync); ordering is derived purely from
// the parent DAG + Lamport counters, never from file order.
export function buildClockIndex(events) {
  const byId = new Map();
  for (const event of events) {
    if (!event.id) throw new ExitError(EXIT.MISSING_PARENT, 'event without id');
    byId.set(event.id, event);
  }
  for (const event of events) {
    for (const parent of event.parents ?? []) {
      if (!byId.has(parent)) {
        throw new ExitError(
          EXIT.MISSING_PARENT,
          `event ${event.id} references missing parent event ${parent}`,
        );
      }
    }
  }
  return byId;
}

// True when `ancestorId` is in the causal past of `eventId` (reachable via parents).
export function isAncestor(byId, ancestorId, eventId) {
  const seen = new Set();
  const stack = [eventId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === ancestorId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const event = byId.get(current);
    if (!event) continue;
    for (const parent of event.parents ?? []) stack.push(parent);
  }
  return false;
}

// Causal chain from `fromId` to `toId` (both inclusive), following parents
// backwards from toId. Returns null when no causal path exists.
export function causalChain(byId, fromId, toId) {
  if (fromId === toId) return [fromId];
  const next = new Map(); // parent -> child that discovered it
  const queue = [toId];
  const seen = new Set([toId]);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const parent of byId.get(current)?.parents ?? []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      next.set(parent, current);
      if (parent === fromId) {
        const chain = [fromId];
        let cursor = fromId;
        while (cursor !== toId) {
          cursor = next.get(cursor);
          chain.push(cursor);
        }
        return chain;
      }
      queue.push(parent);
    }
  }
  return null;
}
