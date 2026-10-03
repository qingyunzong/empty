import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WxError,
  SOFT_RANGE,
  parseStore,
  serializeStore,
  ingestRecords,
  mergeStores,
  compactStore,
  queryStore,
  winnerOf,
} from '../src/store.js';

const emptyStore = () => ({ sites: new Set(), events: [], base: {} });
const T = (h) => `2026-01-01T0${h}:00:00.000Z`;

test('ingest: negative delta is valid, out-of-soft-range is flagged invalid', () => {
  const s = emptyStore();
  const res = ingestRecords(s, 'A', [
    { t: T(1), delta: -3.5, seq: 1 },
    { t: T(2), delta: SOFT_RANGE + 5, seq: 2 },
  ]);
  assert.equal(res.added, 2);
  assert.equal(res.invalid, 1);
  const def = queryStore(s);
  assert.deepEqual(def, [{ site: 'A', t: T(1), delta: -3.5 }]);
  const all = queryStore(s, { includeInvalid: true });
  assert.deepEqual(all[1], { site: 'A', t: T(2), delta: SOFT_RANGE + 5, valid: false });
});

test('ingest: BAD_RANGE on hard-range violation, non-finite delta, bad time, bad seq', () => {
  for (const rec of [
    { t: T(1), delta: 500 },
    { t: T(1), delta: NaN },
    { t: 'not-a-date', delta: 1 },
    { t: T(1), delta: 1, seq: 0 },
  ]) {
    assert.throws(() => ingestRecords(emptyStore(), 'A', [rec]), (e) => {
      assert.ok(e instanceof WxError);
      assert.equal(e.code, 'BAD_RANGE');
      return true;
    });
  }
});

test('ingest: duplicate and out-of-order re-ingest is idempotent', () => {
  const recs = [
    { t: T(1), delta: 1, seq: 1 },
    { t: T(2), delta: 2, seq: 2 },
    { t: T(3), delta: 3, seq: 3 },
  ];
  const a = emptyStore();
  ingestRecords(a, 'A', recs);
  const before = serializeStore(a);
  const res = ingestRecords(a, 'A', [...recs].reverse());
  assert.equal(res.added, 0);
  assert.equal(res.skipped, 3);
  assert.equal(serializeStore(a), before);
});

test('query: UNKNOWN_SITE for unregistered site filter', () => {
  const s = emptyStore();
  ingestRecords(s, 'A', [{ t: T(1), delta: 1, seq: 1 }]);
  assert.throws(() => queryStore(s, { site: 'ZZZ' }), (e) => e.code === 'UNKNOWN_SITE');
  assert.equal(queryStore(s, { site: 'A' }).length, 1);
});

test('tombstone: ingest put on deleted key raises TOMBSTONE_HIT', () => {
  const s = emptyStore();
  ingestRecords(s, 'A', [{ t: T(1), delta: 1, seq: 1 }]);
  ingestRecords(s, 'A', [{ t: T(1), delete: true, seq: 2 }]);
  assert.equal(queryStore(s).length, 0);
  assert.throws(() => ingestRecords(s, 'A', [{ t: T(1), delta: 9, seq: 3 }]), (e) => {
    assert.equal(e.code, 'TOMBSTONE_HIT');
    return true;
  });
});

test('tombstone: stale replica cannot resurrect a deleted key via merge', () => {
  const fresh = emptyStore();
  ingestRecords(fresh, 'A', [{ t: T(1), delta: 1, seq: 1 }]);
  const stale = parseStore(serializeStore(fresh)); // snapshot before delete
  ingestRecords(fresh, 'A', [{ t: T(1), delete: true, seq: 2 }]);
  for (const order of [
    [stale, fresh],
    [fresh, stale],
  ]) {
    const m = mergeStores(order);
    assert.equal(queryStore(m).length, 0, 'deleted key must stay deleted');
  }
});

test('merge: commutative, associative, idempotent on small stores', () => {
  const mk = (site, seed) => {
    const s = emptyStore();
    ingestRecords(
      s,
      site,
      [1, 2, 3].map((i) => ({ t: T((i + seed) % 9), delta: i * seed, seq: i })),
    );
    return s;
  };
  const [a, b, c] = [mk('A', 1), mk('B', 2), mk('C', 3)];
  const ab = mergeStores([a, b]);
  const ba = mergeStores([b, a]);
  assert.equal(serializeStore(ab), serializeStore(ba)); // commutative
  const abc1 = mergeStores([mergeStores([a, b]), c]);
  const abc2 = mergeStores([a, mergeStores([b, c])]);
  assert.equal(serializeStore(abc1), serializeStore(abc2)); // associative
  assert.equal(serializeStore(mergeStores([ab, ab])), serializeStore(ab)); // idempotent
});

test('compact: no-op below min vector, collects covered tombstones, keeps evidence', () => {
  const s = emptyStore();
  // A and B gossip through one shared store so the min vector advances.
  ingestRecords(s, 'A', [
    { t: T(1), delta: 1, seq: 1 },
    { t: T(2), delta: 2, seq: 2 },
  ]);
  ingestRecords(s, 'B', [{ t: T(3), delta: 30, seq: 1 }]); // invalid evidence
  ingestRecords(s, 'A', [{ t: T(1), delete: true, seq: 3 }]); // deletes A@T1
  ingestRecords(s, 'B', [{ t: T(4), delta: 4, seq: 2 }]); // B has seen A's delete

  const before = queryStore(s, { includeInvalid: true });
  const { store: c1, dropped } = compactStore(s);
  assert.ok(dropped > 0, 'covered events should be collected');
  assert.deepEqual(queryStore(c1, { includeInvalid: true }), before, 'visible query unchanged');
  assert.deepEqual(queryStore(c1), queryStore(s), 'default query unchanged');
  // tombstone for A@T1 collected: key fully gone from the store
  assert.ok(!c1.events.some((e) => e.key.site === 'A' && e.key.t === T(1)));
  // invalid evidence kept
  assert.ok(c1.events.some((e) => e.type === 'put' && e.valid === false));
  // compact is stable
  const { store: c2 } = compactStore(c1);
  assert.equal(serializeStore(c2), serializeStore(c1));
});

test('winnerOf: domination beats concurrency, remove-wins on concurrency', () => {
  const put = (v, seq, origin = 'A') => ({
    type: 'put',
    key: { site: 'A', t: T(1) },
    delta: 1,
    valid: true,
    vector: v,
    origin,
    seq,
  });
  const del = (v, seq, origin = 'A') => ({
    type: 'del',
    key: { site: 'A', t: T(1) },
    vector: v,
    origin,
    seq,
  });
  const p1 = put({ A: 1 }, 1);
  const p2 = put({ A: 2 }, 2);
  assert.equal(winnerOf([p1, p2]), p2); // causal domination
  const d3 = del({ A: 3 }, 3);
  assert.equal(winnerOf([p2, d3]), d3); // delete after put
  const pOther = put({ B: 1 }, 1, 'B'); // concurrent with p1
  assert.equal(winnerOf([p1, pOther]).type, 'put');
  const dOther = del({ B: 1 }, 1, 'B'); // concurrent with p1 -> remove wins
  assert.equal(winnerOf([p1, dOther]), dOther);
});

test('parseStore: BAD_RANGE on malformed lines', () => {
  assert.throws(() => parseStore('{not json}\n'), (e) => e.code === 'BAD_RANGE');
  assert.throws(
    () => parseStore('{"type":"put","key":{"site":"A","t":"x"},"vector":{},"origin":"A","seq":1,"delta":1}\n'),
    (e) => e.code === 'BAD_RANGE',
  );
});
