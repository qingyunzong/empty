import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { analyzeEvents } from '../src/graph.js';

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Scale: up to 3000 events per shift.
test('3000-event chain + 5000 random redundant edges: EQUAL, UNDECIDED, snapshot round-trip', () => {
  const n = 3000;
  const rand = mulberry32(7);
  const chain = [];
  for (let i = 0; i < n; i++) chain.push({ id: 'e' + i, preds: i === 0 ? [] : ['e' + (i - 1)] });
  const dense = chain.map((e) => ({ id: e.id, preds: [...e.preds] }));
  for (let k = 0; k < 5000; k++) {
    const j = 1 + Math.floor(rand() * (n - 1));
    const i = Math.floor(rand() * j);
    dense[j].preds.push('e' + i);
  }
  const s = new Store();
  assert.equal(s.ingest('chain', chain).status, 'OK');
  assert.equal(s.ingest('dense', dense).status, 'OK');
  assert.equal(s.equiv('chain', 'dense').status, 'EQUAL');

  // remove the middle chain edge from a copy -> UNDECIDED
  const broken = dense.map((e) => ({ id: e.id, preds: e.id === 'e1500' ? [] : [...e.preds] }));
  s.ingest('broken', broken);
  const r = s.equiv('dense', 'broken');
  assert.equal(r.status, 'UNDECIDED');
  assert.ok(r.missing_edges.some((e) => e.from === 'e1499' && e.to === 'e1500'));

  const snap = s.snapshot();
  const restored = Store.restore(snap);
  assert.equal(restored.status, 'OK');
  assert.equal(restored.store.equiv('chain', 'dense').status, 'EQUAL');
});

test('3000-event cycle compresses to a single SCC', () => {
  const n = 3000;
  const events = [];
  for (let i = 0; i < n; i++) events.push({ id: 'e' + i, preds: ['e' + ((i + 1) % n)] });
  const an = analyzeEvents(new Map(events.map((e) => [e.id, { preds: e.preds }])));
  assert.equal(an.compCount, 1);
  // a single component with no inter-component edges is both source and sink
  assert.deepEqual(an.sources, an.sinks);
  assert.equal(an.sources.length, 1);
});
