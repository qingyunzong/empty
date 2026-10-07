import { emptyState, applyEvent, mergeAll, mergeStates, canonicalState } from '../src/state.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeEvents(seed, count, { nodes = ['t1', 't2'] } = {}) {
  const rnd = mulberry32(seed);
  const events = [];
  const produced = { t1: 0, t2: 0 };
  const rejected = { t1: 0, t2: 0 };
  const downtimeIds = [];
  for (let i = 0; i < count; i++) {
    const node = nodes[Math.floor(rnd() * nodes.length)];
    const ts = 1000 + Math.floor(rnd() * 28000);
    const kind = rnd();
    if (kind < 0.45) {
      const delta = 1 + Math.floor(rnd() * 20);
      produced[node] += delta;
      events.push({ id: `e${i}`, type: 'count', counter: 'produced', node, delta, ts });
    } else if (kind < 0.65) {
      const cap = Math.max(0, Math.min(produced[node] - rejected[node], 5));
      const delta = Math.floor(rnd() * (cap + 1));
      rejected[node] += delta;
      events.push({ id: `e${i}`, type: 'count', counter: 'rejected', node, delta, ts });
    } else if (kind < 0.85) {
      const start = 1000 + Math.floor(rnd() * 27000);
      events.push({ id: `e${i}`, type: 'downtime', node, start, end: start + 30 + Math.floor(rnd() * 600), ts });
      downtimeIds.push(`e${i}`);
    } else if (downtimeIds.length > 0) {
      const target = downtimeIds[Math.floor(rnd() * downtimeIds.length)];
      events.push({ id: `e${i}`, type: 'revoke', target, node, ts });
    } else {
      const delta = 1 + Math.floor(rnd() * 10);
      produced[node] += delta;
      events.push({ id: `e${i}`, type: 'count', counter: 'produced', node, delta, ts });
    }
  }
  return events;
}

export function ingestAll(events, opts) {
  const state = emptyState();
  for (const e of events) applyEvent(state, e, opts);
  return state;
}

export function shardOf(events) {
  return events.map((e) => ingestAll([e]));
}

export function shuffled(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export { emptyState, applyEvent, mergeAll, mergeStates, canonicalState };
