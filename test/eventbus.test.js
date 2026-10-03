import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EventBus,
  BusError,
  INVALID_INPUT,
  ROLLBACK_RANGE,
  REACHABLE,
  NOT_REACHABLE,
  CONCURRENT,
  UNDECIDED,
} from '../src/eventbus.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 1: concurrent branches are distinguished from real ordering', () => {
  const bus = new EventBus();
  // Root fault on the line, then three independent alarm branches at the
  // same physical moment, plus one genuinely ordered chain.
  bus.observe({ id: 'root', ts: 100, node: 'plc-0' });
  bus.observe({ id: 'a1', ts: 200, node: 'press-1' });
  bus.observe({ id: 'a2', ts: 200, node: 'press-2' });
  bus.observe({ id: 'a3', ts: 200, node: 'press-3' });
  bus.observe({ id: 'b1', ts: 300, node: 'press-1' });
  bus.observe({ id: 'b2', ts: 400, node: 'press-1' });
  bus.link({ a: 'root', b: 'a1', kind: 'causes' });
  bus.link({ a: 'root', b: 'a2', kind: 'causes' });
  bus.link({ a: 'root', b: 'a3', kind: 'causes' });
  bus.link({ a: 'b1', b: 'b2', kind: 'causes' });

  // Real causal order is reported as such, both directions.
  assert.equal(bus.query('root', 'a1'), REACHABLE);
  assert.equal(bus.query('a1', 'root'), NOT_REACHABLE);
  assert.equal(bus.query('b1', 'b2'), REACHABLE);
  assert.equal(bus.query('b2', 'b1'), NOT_REACHABLE);

  // The three branches at the same physical moment are concurrent, not ordered.
  assert.equal(bus.query('a1', 'a2'), CONCURRENT);
  assert.equal(bus.query('a2', 'a3'), CONCURRENT);
  assert.equal(bus.query('a3', 'a1'), CONCURRENT);

  // Different timestamps with no causal evidence either way: UNDECIDED,
  // and it must never collapse into NOT_REACHABLE.
  assert.equal(bus.query('a1', 'b1'), UNDECIDED);
  assert.notEqual(bus.query('a1', 'b1'), NOT_REACHABLE);
  assert.equal(bus.query('b2', 'a3'), UNDECIDED);
});

test('acceptance 2: cycle A->B->C->A yields one SCC and consistent reachability', () => {
  const bus = new EventBus();
  bus.observe({ id: 'A', ts: 1, node: 'sensor-a' });
  bus.observe({ id: 'B', ts: 2, node: 'sensor-b' });
  bus.observe({ id: 'C', ts: 3, node: 'sensor-c' });
  bus.observe({ id: 'D', ts: 4, node: 'sensor-d' });
  bus.link({ a: 'A', b: 'B' });
  bus.link({ a: 'B', b: 'C' });
  bus.link({ a: 'C', b: 'A' });
  bus.link({ a: 'C', b: 'D' });

  // The cyclic sensor config is reported as a single sorted SCC.
  assert.deepEqual(bus.scc(), [['A', 'B', 'C']]);

  // Reachability stays consistent with the cycle: every member reaches
  // every other member, and the cycle reaches downstream D.
  for (const x of ['A', 'B', 'C']) {
    for (const y of ['A', 'B', 'C']) {
      assert.equal(bus.query(x, y), REACHABLE, `${x} -> ${y}`);
    }
    assert.equal(bus.query(x, 'D'), REACHABLE, `${x} -> D`);
  }
  assert.equal(bus.query('D', 'A'), NOT_REACHABLE);

  // A second, independent cycle is reported as its own component.
  bus.observe({ id: 'X', ts: 5, node: 'sensor-x' });
  bus.observe({ id: 'Y', ts: 6, node: 'sensor-y' });
  bus.link({ a: 'X', b: 'Y' });
  bus.link({ a: 'Y', b: 'X' });
  assert.deepEqual(bus.scc(), [
    ['A', 'B', 'C'],
    ['X', 'Y'],
  ]);
});

test('acceptance 3: random partial orders (n<=9) match brute-force transitive closure', () => {
  for (let trial = 0; trial < 300; trial++) {
    const rand = mulberry32(trial * 2654435761 + 97);
    const n = 2 + Math.floor(rand() * 8); // 2..9 events
    const bus = new EventBus();
    const ids = [];
    for (let i = 0; i < n; i++) {
      const id = `e${i}`;
      ids.push(id);
      bus.observe({ id, ts: Math.floor(rand() * 4), node: `dev-${i % 3}` });
    }
    // Random DAG: shuffle a topological order, add forward edges with p=0.35.
    const order = [...ids];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const index = new Map(ids.map((id, i) => [id, i]));
    const closure = Array.from({ length: n }, () => new Array(n).fill(false));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.35) {
          bus.link({ a: order[i], b: order[j], kind: 'causes' });
          closure[index.get(order[i])][index.get(order[j])] = true;
        }
      }
    }
    // Brute-force transitive closure (Floyd-Warshall).
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          closure[i][j] = closure[i][j] || (closure[i][k] && closure[k][j]);
        }
      }
    }
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const result = bus.query(a, b);
        const fwd = closure[index.get(a)][index.get(b)];
        const rev = closure[index.get(b)][index.get(a)];
        const label = `trial=${trial} ${a}->${b}`;
        assert.equal(result === REACHABLE, fwd, `${label}: REACHABLE mismatch`);
        if (!fwd && rev) {
          assert.equal(result, NOT_REACHABLE, `${label}: expected NOT_REACHABLE`);
        }
        if (!fwd && !rev) {
          assert.ok(result === CONCURRENT || result === UNDECIDED, `${label}: expected CONCURRENT/UNDECIDED`);
          assert.notEqual(result, NOT_REACHABLE, `${label}: UNDECIDED must not be NOT_REACHABLE`);
          const sameTs = bus.ts(a) === bus.ts(b);
          assert.equal(result, sameTs ? CONCURRENT : UNDECIDED, `${label}: ts rule`);
        }
      }
    }
  }
});

test('acceptance 4: rollback across checkpoints restores events, edges and queries', () => {
  const bus = new EventBus();
  bus.observe({ id: 'e1', ts: 1, node: 'n1' });
  bus.observe({ id: 'e2', ts: 2, node: 'n1' });
  bus.link({ a: 'e1', b: 'e2' });
  bus.checkpoint(); // layer 1

  bus.observe({ id: 'e3', ts: 3, node: 'n2' });
  bus.observe({ id: 'e4', ts: 4, node: 'n2' });
  bus.link({ a: 'e2', b: 'e3' });
  bus.link({ a: 'e3', b: 'e4' });
  bus.checkpoint(); // layer 2

  bus.observe({ id: 'e5', ts: 5, node: 'n3' });
  bus.link({ a: 'e4', b: 'e5' });

  // Full state sanity.
  assert.deepEqual(bus.eventIds(), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.equal(bus.query('e1', 'e5'), REACHABLE);

  // Undo the most recent layer only.
  bus.rollback(1);
  assert.deepEqual(bus.eventIds(), ['e1', 'e2', 'e3', 'e4']);
  assert.deepEqual(bus.edges(), [
    ['e1', 'e2'],
    ['e2', 'e3'],
    ['e3', 'e4'],
  ]);
  assert.equal(bus.query('e1', 'e4'), REACHABLE);
  assert.throws(() => bus.query('e1', 'e5'), (err) => err instanceof BusError && err.code === INVALID_INPUT);

  // Undo across the remaining checkpoint: back to layer-1 state.
  bus.rollback(1);
  assert.deepEqual(bus.eventIds(), ['e1', 'e2']);
  assert.deepEqual(bus.edges(), [['e1', 'e2']]);
  assert.equal(bus.query('e1', 'e2'), REACHABLE);
  assert.equal(bus.query('e2', 'e1'), NOT_REACHABLE);
  assert.equal(bus.layers, 0);

  // rollback(0) is a no-op.
  bus.checkpoint();
  bus.rollback(0);
  assert.deepEqual(bus.eventIds(), ['e1', 'e2']);
  assert.equal(bus.layers, 1);

  // One rollback spanning multiple layers at once.
  bus.observe({ id: 'x1', ts: 10, node: 'n9' });
  bus.checkpoint();
  bus.observe({ id: 'x2', ts: 11, node: 'n9' });
  bus.link({ a: 'x1', b: 'x2' });
  bus.checkpoint();
  assert.equal(bus.layers, 3);
  bus.rollback(2);
  assert.deepEqual(bus.eventIds(), ['e1', 'e2', 'x1']);
  assert.equal(bus.layers, 1);
  bus.rollback(1);
  assert.deepEqual(bus.eventIds(), ['e1', 'e2']);
  assert.equal(bus.layers, 0);
});

test('acceptance 4b: failed rollback keeps state and reports ROLLBACK_RANGE', () => {
  const bus = new EventBus();
  bus.observe({ id: 'e1', ts: 1, node: 'n1' });
  bus.observe({ id: 'e2', ts: 2, node: 'n1' });
  bus.link({ a: 'e1', b: 'e2' });
  bus.checkpoint();
  bus.observe({ id: 'e3', ts: 3, node: 'n2' });
  bus.checkpoint();

  const before = { ids: bus.eventIds(), edges: bus.edges(), layers: bus.layers };
  assert.throws(() => bus.rollback(3), (err) => err instanceof BusError && err.code === ROLLBACK_RANGE);
  assert.throws(() => bus.rollback(99), (err) => err.code === ROLLBACK_RANGE);
  assert.deepEqual(bus.eventIds(), before.ids);
  assert.deepEqual(bus.edges(), before.edges);
  assert.equal(bus.layers, before.layers);
  assert.equal(bus.query('e1', 'e2'), REACHABLE);
});

test('acceptance 5: duplicate id, missing endpoint, negative k report INVALID_INPUT', () => {
  const bus = new EventBus();
  bus.observe({ id: 'e1', ts: 1, node: 'n1' });

  // Duplicate id.
  assert.throws(() => bus.observe({ id: 'e1', ts: 2, node: 'n1' }), (err) => err.code === INVALID_INPUT);

  // Missing link endpoints (either side).
  assert.throws(() => bus.link({ a: 'e1', b: 'ghost' }), (err) => err.code === INVALID_INPUT);
  assert.throws(() => bus.link({ a: 'ghost', b: 'e1' }), (err) => err.code === INVALID_INPUT);

  // Negative / non-integer k.
  assert.throws(() => bus.rollback(-1), (err) => err.code === INVALID_INPUT);
  assert.throws(() => bus.rollback(1.5), (err) => err.code === INVALID_INPUT);

  // Malformed observe payloads.
  assert.throws(() => bus.observe({ id: '', ts: 1, node: 'n1' }), (err) => err.code === INVALID_INPUT);
  assert.throws(() => bus.observe({ id: 'e2', ts: 'soon', node: 'n1' }), (err) => err.code === INVALID_INPUT);
  assert.throws(() => bus.observe({ id: 'e2', ts: Number.NaN, node: 'n1' }), (err) => err.code === INVALID_INPUT);

  // Query with unknown endpoint.
  assert.throws(() => bus.query('e1', 'ghost'), (err) => err.code === INVALID_INPUT);

  // State untouched by all the rejected ops.
  assert.deepEqual(bus.eventIds(), ['e1']);
  assert.deepEqual(bus.edges(), []);
});

test('scale: 4000 events replay and query within reasonable effort', () => {
  const bus = new EventBus();
  const n = 4000;
  for (let i = 0; i < n; i++) {
    bus.observe({ id: `ev${i}`, ts: i, node: `cell-${i % 16}` });
    if (i > 0) bus.link({ a: `ev${i - 1}`, b: `ev${i}` });
  }
  bus.checkpoint();
  assert.equal(bus.query('ev0', `ev${n - 1}`), REACHABLE);
  assert.equal(bus.query(`ev${n - 1}`, 'ev0'), NOT_REACHABLE);
  bus.observe({ id: 'extra', ts: n, node: 'cell-0' });
  bus.link({ a: `ev${n - 1}`, b: 'extra' });
  assert.equal(bus.query('ev0', 'extra'), REACHABLE);
  bus.rollback(1);
  assert.equal(bus.size, n);
  assert.throws(() => bus.query('ev0', 'extra'), (err) => err.code === 'INVALID_INPUT');
});
