'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { check, mergedOrder } = require('../src/history');
const { bruteCheck } = require('../src/brute');
const { mulberry32 } = require('./helpers');

// Acceptance scenario 3: random mixed histories, graph checker cross-checked
// against a brute-force reference that enumerates all serial permutations.
//
// Generator notes: write values are unique per key and each key has at most
// two writers, which makes reads-from uniquely determined and the graph
// checker's verdict exact (every dependency edge is then a necessary
// constraint), so it must agree with brute force on every case.

function genCase(rng) {
  const nKeys = 2 + Math.floor(rng() * 2); // 2..3 keys
  const keys = Array.from({ length: nKeys }, (_, i) => 'k' + i);
  const replicas = ['A', 'B', 'C'].slice(0, 2 + Math.floor(rng() * 2));
  const txns = [];
  let vc = 0;
  for (const k of keys) {
    const nw = 1 + Math.floor(rng() * 2); // 1..2 writers per key
    for (let i = 0; i < nw; i++) {
      txns.push({ writes: { [k]: 'v' + vc++ }, readKeys: [] });
    }
  }
  const nReaders = 1 + Math.floor(rng() * 2); // 1..2 pure readers
  for (let i = 0; i < nReaders; i++) {
    const nr = 1 + Math.floor(rng() * 2);
    const rk = new Set();
    for (let j = 0; j < nr; j++) rk.add(keys[Math.floor(rng() * keys.length)]);
    txns.push({ writes: {}, readKeys: [...rk] });
  }
  // writers may also read a different key
  for (const t of txns) {
    const own = Object.keys(t.writes)[0];
    if (rng() < 0.4) {
      const others = keys.filter((k) => k !== own);
      if (others.length) t.readKeys.push(others[Math.floor(rng() * others.length)]);
    }
  }
  if (txns.length > 7) return null; // keep brute force tractable

  // scatter transactions across replicas (concurrent vector clocks)
  const seqs = {};
  for (const t of txns) {
    const r = replicas[Math.floor(rng() * replicas.length)];
    seqs[r] = (seqs[r] || 0) + 1;
    t.node = r;
    t.seq = seqs[r];
    t.id = `${r}:${t.seq}`;
    t.clock = { [r]: t.seq };
  }

  // execute in merged order to produce realistic recorded reads
  const state = {};
  for (const t of mergedOrder(txns)) {
    t.reads = {};
    for (const k of t.readKeys) t.reads[k] = state[k] === undefined ? null : state[k];
    Object.assign(state, t.writes);
  }

  // mutate one recorded read to (often) break serializability
  if (rng() < 0.7) {
    const readers = txns.filter((t) => Object.keys(t.reads).length > 0);
    if (readers.length) {
      const t = readers[Math.floor(rng() * readers.length)];
      const ks = Object.keys(t.reads);
      const k = ks[Math.floor(rng() * ks.length)];
      const vals = txns.filter((o) => o.writes[k] !== undefined).map((o) => o.writes[k]);
      const choice = rng();
      if (choice < 0.4 && vals.length) t.reads[k] = vals[Math.floor(rng() * vals.length)];
      else if (choice < 0.7) t.reads[k] = null;
      else t.reads[k] = 'bogus';
    }
  }
  return txns;
}

test('random mixed histories: graph checker agrees with brute force', () => {
  const rng = mulberry32(1337);
  const N = 300;
  let serializable = 0;
  let nonSerializable = 0;
  let generated = 0;
  while (generated < N) {
    const txns = genCase(rng);
    if (!txns) continue;
    generated++;
    const graph = check(txns);
    const brute = bruteCheck(txns);
    const graphSays = graph.status === 'SERIALIZABLE';
    assert.equal(
      graphSays,
      brute.serializable,
      `case ${generated}: graph=${graph.status} brute=${brute.serializable} txns=${JSON.stringify(txns)}`
    );
    if (graphSays) {
      serializable++;
      assert.ok(Array.isArray(graph.order) && graph.order.length === txns.length);
    } else {
      nonSerializable++;
      // reported cycle must reference real transactions and be closed
      const ids = new Set(txns.map((t) => t.id));
      assert.equal(graph.cycle[0], graph.cycle[graph.cycle.length - 1]);
      for (const id of graph.cycle) assert.ok(ids.has(id));
    }
  }
  // the mix must actually contain both kinds
  assert.ok(serializable > 0, 'expected some serializable cases');
  assert.ok(nonSerializable > 0, 'expected some non-serializable cases');
  console.log(`random cross-check: ${N} cases, serializable=${serializable}, non-serializable=${nonSerializable}, all verdicts match brute force`);
});
