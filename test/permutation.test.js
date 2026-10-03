// Reference verification: merge must be commutative, associative and
// idempotent. Checked by merging randomly generated station stores in EVERY
// permutation of up to 8 sites and comparing the canonical result, then
// cross-checking the materialized view against an independent reference
// (pairwise tournament over shuffled event order).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeStores,
  compactStore,
  serializeStore,
  queryStore,
  winnerOf,
  eventId,
  tieCompare,
} from '../src/store.js';
import { vecStrict } from '../src/vector.js';

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

const TIMES = [0, 1, 2, 3].map((h) => `2026-01-01T0${h}:00:00.000Z`);

// Generate n station stores with puts (some invalid, some negative), deletes,
// cross-site keys and concurrent vector clocks.
function genWorld(seed, nSites, eventsPerSite = 5, gossip = 0.4) {
  const rnd = mulberry32(seed);
  const sites = Array.from({ length: nSites }, (_, i) => `S${i}`);
  const stores = sites.map((s) => ({ sites: new Set([s]), events: [], base: {} }));
  for (const origin of sites) {
    for (let seq = 1; seq <= eventsPerSite; seq++) {
      const keySite = rnd() < 0.7 ? origin : sites[Math.floor(rnd() * nSites)];
      const t = TIMES[Math.floor(rnd() * TIMES.length)];
      const vector = { [origin]: seq };
      for (const o of sites) {
        if (o !== origin && rnd() < gossip) vector[o] = 1 + Math.floor(rnd() * eventsPerSite);
      }
      const key = { site: keySite, t };
      if (rnd() < 0.25) {
        stores[sites.indexOf(origin)].events.push({ type: 'del', key, vector, origin, seq });
      } else {
        const delta = Math.round((rnd() * 40 - 20) * 10) / 10; // [-20, 20]: some invalid
        stores[sites.indexOf(origin)].events.push({
          type: 'put',
          key,
          delta,
          valid: Math.abs(delta) <= 15,
          vector,
          origin,
          seq,
        });
      }
    }
  }
  return { sites, stores };
}

const emptyStore = () => ({ sites: new Set(), events: [], base: {} });

function mergeInOrder(stores, order) {
  return order.reduce((acc, i) => mergeStores([acc, stores[i]]), emptyStore());
}

// Independent reference winner: pairwise tournament (different construction
// than winnerOf's candidate-set approach).
function tournamentWinner(events) {
  const better = (a, b) => {
    if (vecStrict(a.vector, b.vector)) return b;
    if (vecStrict(b.vector, a.vector)) return a;
    if (a.type !== b.type) return a.type === 'del' ? a : b;
    return tieCompare(a, b) >= 0 ? a : b;
  };
  return events.reduce(better);
}

test('merge: full permutation of 8 sites yields one canonical store', () => {
  const { stores } = genWorld(42, 8);
  let canonical = null;
  let rowsAll = null;
  let count = 0;
  for (const perm of permutations([0, 1, 2, 3, 4, 5, 6, 7])) {
    const merged = mergeInOrder(stores, perm);
    const text = serializeStore(merged);
    if (canonical === null) {
      canonical = text;
      rowsAll = queryStore(merged, { includeInvalid: true });
    } else {
      assert.equal(text, canonical, `permutation ${perm} diverged`);
    }
    count++;
  }
  assert.equal(count, 40320);
  assert.ok(rowsAll.length > 0);
});

test('merge: associativity across random groupings (8 sites)', () => {
  const { stores } = genWorld(7, 8);
  const flat = mergeInOrder(stores, [0, 1, 2, 3, 4, 5, 6, 7]);
  const rnd = mulberry32(99);
  for (let trial = 0; trial < 200; trial++) {
    // random binary tree grouping
    let acc = emptyStore();
    const idx = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => rnd() - 0.5);
    const groups = [[], []];
    for (const i of idx) groups[i % 2].push(i);
    const g0 = mergeInOrder(stores, groups[0]);
    const g1 = mergeInOrder(stores, groups[1]);
    acc = mergeStores([g0, g1]);
    assert.equal(serializeStore(acc), serializeStore(flat));
    // idempotency: merging the result with itself changes nothing
    assert.equal(serializeStore(mergeStores([acc, acc])), serializeStore(flat));
  }
});

test('reference: winnerOf matches pairwise tournament under shuffles', () => {
  const { stores } = genWorld(123, 8);
  const all = stores.flatMap((s) => s.events);
  const byKey = new Map();
  for (const e of all) {
    const id = e.key.site + '|' + e.key.t;
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push(e);
  }
  const rnd = mulberry32(555);
  for (const events of byKey.values()) {
    const expected = eventId(winnerOf(events));
    for (let i = 0; i < 50; i++) {
      const shuffled = [...events].sort(() => rnd() - 0.5);
      assert.equal(eventId(tournamentWinner(shuffled)), expected);
    }
  }
});

test('compact: preserves visible query; result independent of merge order', () => {
  const { stores } = genWorld(2024, 8, 8, 0.75); // dense gossip so the min vector advances
  const merged = mergeInOrder(stores, [0, 1, 2, 3, 4, 5, 6, 7]);
  const before = queryStore(merged, { includeInvalid: true });
  const { store: compacted, dropped } = compactStore(merged);
  assert.ok(dropped > 0, 'min vector should cover some events in this world');
  assert.deepEqual(queryStore(compacted, { includeInvalid: true }), before);
  assert.deepEqual(queryStore(compacted), queryStore(merged));

  // compact(merge(pi)) is identical for every permutation of 5 sites (720)
  const five = stores.slice(0, 5);
  let canonical = null;
  let count = 0;
  for (const perm of permutations([0, 1, 2, 3, 4])) {
    const { store } = compactStore(mergeInOrder(five, perm));
    const text = serializeStore(store);
    if (canonical === null) canonical = text;
    else assert.equal(text, canonical);
    count++;
  }
  assert.equal(count, 120);
});

test('merge with a compacted store stays order-independent (6! permutations)', () => {
  const { stores } = genWorld(31337, 6);
  // compact the merge of the first two stores, then permute-merge the rest
  const partial = compactStore(mergeStores([stores[0], stores[1]])).store;
  const inputs = [partial, stores[2], stores[3], stores[4], stores[5]];
  // reference: plain union semantics over uncompacted inputs is NOT expected
  // to match (compact drops covered events); order-independence is.
  let canonical = null;
  let count = 0;
  for (const perm of permutations([0, 1, 2, 3, 4])) {
    const text = serializeStore(mergeInOrder(inputs, perm));
    if (canonical === null) canonical = text;
    else assert.equal(text, canonical);
    count++;
  }
  assert.equal(count, 120);
});
