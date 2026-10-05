import { shapeHit, compareHits } from '../src/query.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function genEvents(seed, n, vocab, devices) {
  const rnd = mulberry32(seed);
  const events = [];
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(rnd() * 3);
    const tokens = [];
    for (let j = 0; j < len; j++) tokens.push(vocab[Math.floor(rnd() * vocab.length)]);
    events.push({
      id: `e${String(i + 1).padStart(8, '0')}`,
      seq: i + 1,
      ts: (i + 1) * 10,
      device: devices[Math.floor(rnd() * devices.length)],
      tokens,
    });
  }
  return events;
}

// Naive oracle: builds the same per-device global stream the archive defines
// (chain order = event append order) and scans it directly.
export function bruteForce(events, cutoff, query) {
  const byDevice = new Map();
  for (const e of events) {
    if (!byDevice.has(e.device)) byDevice.set(e.device, []);
    byDevice.get(e.device).push(e);
  }
  const streams = new Map();
  for (const [dev, list] of byDevice) {
    const tokens = [];
    const owner = [];
    const evts = [];
    for (const e of list) {
      const start = tokens.length;
      for (const t of e.tokens) { tokens.push(t); owner.push(e); }
      evts.push({ id: e.id, ts: e.ts, start, end: tokens.length - 1, tombstoned: e.ts < cutoff });
    }
    streams.set(dev, { tokens, owner, events: evts });
  }
  const hits = [];
  if (query.type === 'phrase') {
    const q = query.tokens;
    for (const [dev, s] of streams) {
      for (let i = 0; i + q.length <= s.tokens.length; i++) {
        let ok = true;
        for (let j = 0; j < q.length && ok; j++) {
          if (s.tokens[i + j] !== q[j] || s.owner[i + j].ts < cutoff) ok = false;
        }
        if (ok) hits.push(shapeHit('phrase', dev, i, i + q.length - 1, s.events));
      }
    }
  } else {
    const { a, b, k } = query;
    for (const [dev, s] of streams) {
      for (let i = 0; i < s.tokens.length; i++) {
        if (s.tokens[i] !== a || s.owner[i].ts < cutoff) continue;
        for (let j = Math.max(0, i - k); j <= Math.min(s.tokens.length - 1, i + k); j++) {
          if (s.tokens[j] !== b || s.owner[j].ts < cutoff) continue;
          if (a === b && i === j) continue;
          hits.push(shapeHit('near', dev, Math.min(i, j), Math.max(i, j), s.events));
        }
      }
    }
  }
  return hits.sort(compareHits);
}
