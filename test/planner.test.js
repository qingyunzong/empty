'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Planner } = require('../src/planner');
const { runLines } = require('../cli');

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

// Acceptance 1: chain and parallel durations are correct.
test('chain schedule: sequential start/end and makespan', () => {
  const p = new Planner();
  p.addTask('a', 3, 10);
  p.addTask('b', 2, 10);
  p.addTask('c', 5, 10);
  p.dep('a', 'b');
  p.dep('b', 'c');
  const r = p.schedule(100);
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.order, ['a', 'b', 'c']);
  assert.deepEqual(r.start, { a: 0, b: 3, c: 5 });
  assert.deepEqual(r.end, { a: 3, b: 5, c: 10 });
  assert.equal(r.makespan, 10);
  assert.equal(r.total_cost, 30);
});

test('parallel schedule: independent tasks overlap, makespan is critical path', () => {
  const p = new Planner();
  p.addTask('a', 3, 10);
  p.addTask('b', 4, 10);
  p.addTask('c', 2, 10);
  p.dep('a', 'c');
  p.dep('b', 'c');
  const r = p.schedule(100);
  assert.equal(r.status, 'OK');
  assert.equal(r.start.a, 0);
  assert.equal(r.start.b, 0);
  assert.equal(r.start.c, 4); // waits for the longer branch
  assert.equal(r.makespan, 6);
  // same-layer tie: longer duration first, then id lexicographic
  assert.deepEqual(r.order, ['b', 'a', 'c']);
});

test('same-start tie breaks by id lexicographically when durations equal', () => {
  const p = new Planner();
  p.addTask('zeta', 2, 1);
  p.addTask('alpha', 2, 1);
  const r = p.schedule(10);
  assert.deepEqual(r.order, ['alpha', 'zeta']);
});

// Acceptance 2: cycles compress into SCCs and still order against external nodes.
test('cycle compresses to SCC and stays orderable with external nodes', () => {
  const p = new Planner();
  p.addTask('p', 1, 1);
  p.addTask('x', 2, 5);
  p.addTask('y', 3, 7);
  p.addTask('q', 1, 1);
  p.dep('x', 'y');
  p.dep('y', 'x'); // cycle x <-> y
  p.dep('p', 'x'); // external predecessor
  p.dep('y', 'q'); // external successor

  const r = p.schedule(100);
  assert.equal(r.status, 'CYCLE');
  assert.deepEqual(r.sccs, [['x', 'y']]);
  // break suggestions: edges inside the SCC, cost = source task cost, ascending
  assert.deepEqual(r.break_suggestions, [
    { edge: ['x', 'y'], cost: 5 },
    { edge: ['y', 'x'], cost: 7 },
  ]);

  // condensed DAG keeps external ordering: p-scc -> cycle-scc -> q-scc
  const { sccs, sccOf, dag } = p.condense();
  const cyc = sccOf.get('x');
  assert.equal(sccOf.get('y'), cyc);
  assert.ok(dag.get(sccOf.get('p')).has(cyc));
  assert.ok(dag.get(cyc).has(sccOf.get('q')));
  assert.equal(sccs.length, 3);

  // topological order of the condensed DAG places p before the cycle and q after
  const indeg = new Map(sccs.map((_, i) => [i, 0]));
  for (const succ of dag.values()) for (const j of succ) indeg.set(j, indeg.get(j) + 1);
  const topo = [];
  const queue = [...indeg.keys()].filter((i) => indeg.get(i) === 0);
  while (queue.length) {
    const i = queue.shift();
    topo.push(i);
    for (const j of dag.get(i)) {
      indeg.set(j, indeg.get(j) - 1);
      if (indeg.get(j) === 0) queue.push(j);
    }
  }
  assert.ok(topo.indexOf(sccOf.get('p')) < topo.indexOf(cyc));
  assert.ok(topo.indexOf(cyc) < topo.indexOf(sccOf.get('q')));
});

test('self loop is reported as a cycle', () => {
  const p = new Planner();
  p.addTask('a', 1, 4);
  p.dep('a', 'a');
  const r = p.schedule(10);
  assert.equal(r.status, 'CYCLE');
  assert.deepEqual(r.sccs, [['a']]);
  assert.deepEqual(r.break_suggestions, [{ edge: ['a', 'a'], cost: 4 }]);
});

// Acceptance 3: budget boundary — exact budget feasible, one less INFEASIBLE.
test('budget boundary: exact total cost feasible, one less is INFEASIBLE', () => {
  const build = () => {
    const p = new Planner();
    p.addTask('a', 1, 40);
    p.addTask('b', 1, 35);
    p.addTask('c', 1, 25);
    p.dep('a', 'b');
    return p;
  };
  const feasible = build().schedule(100);
  assert.equal(feasible.status, 'OK');
  assert.equal(feasible.total_cost, 100);
  const infeasible = build().schedule(99);
  assert.equal(infeasible.status, 'INFEASIBLE');
  assert.equal(infeasible.total_cost, 100);
  assert.equal(infeasible.budget, 99);
  // INFEASIBLE never drops tasks: full cost is always reported
  assert.equal(build().schedule(0).status, 'INFEASIBLE');
});

// Acceptance 4: three-level groups; rollback restores deps, cost, committed flags.
test('three-level group rollback restores deps, cost and committed flags', () => {
  const p = new Planner();
  p.addTask('base', 1, 10);

  p.groupBegin(); // level 1
  p.addTask('t1', 2, 10);
  p.dep('base', 't1');
  p.groupBegin(); // level 2
  p.addTask('t2', 2, 20);
  p.dep('t1', 't2');
  p.groupBegin(); // level 3
  p.addTask('t3', 2, 30);
  p.dep('t2', 't3');
  p.groupEnd();
  p.groupEnd();
  p.groupEnd();

  p.commit();
  assert.deepEqual(p.groupStates(), [
    { level: 3, committed: true },
    { level: 2, committed: true },
    { level: 1, committed: true },
  ]);
  assert.equal(p.totalCost(), 70);
  assert.equal(p.schedule(70).status, 'OK');

  // out-of-range rollback: ROLLBACK_RANGE and state untouched
  const before = JSON.stringify(p.schedule(70));
  assert.equal(p.rollback(4), 'ROLLBACK_RANGE');
  assert.equal(p.rollback(-1), 'ROLLBACK_RANGE');
  assert.equal(JSON.stringify(p.schedule(70)), before);
  assert.equal(p.totalCost(), 70);

  // rollback to level 1: levels 2 and 3 (tasks, deps, committed flags) are gone
  assert.equal(p.rollback(1), 'OK');
  assert.deepEqual(p.groupStates(), [{ level: 1, committed: true }]);
  assert.equal(p.totalCost(), 20); // base + t1
  const r = p.schedule(20);
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.order, ['base', 't1']);
  assert.equal(r.start.t1, 1); // dep base -> t1 survived

  // rollback to level 0 removes the remaining group too
  assert.equal(p.rollback(0), 'OK');
  assert.deepEqual(p.groupStates(), []);
  assert.equal(p.totalCost(), 10);
  assert.deepEqual(p.schedule(10).order, ['base']);
});

// Acceptance 5: n <= 9 cross-checked against topological-order enumeration.
function bruteForceMakespan(ids, dur, edges) {
  const preds = new Map(ids.map((id) => [id, []]));
  for (const [a, b] of edges) preds.get(b).push(a);
  let best = Infinity;
  const used = new Set();
  const ends = new Map();
  const walk = () => {
    if (used.size === ids.length) {
      let m = 0;
      for (const e of ends.values()) m = Math.max(m, e);
      best = Math.min(best, m);
      return;
    }
    for (const id of ids) {
      if (used.has(id)) continue;
      if (preds.get(id).some((p) => !used.has(p))) continue;
      let s = 0;
      for (const p of preds.get(id)) s = Math.max(s, ends.get(p));
      used.add(id);
      ends.set(id, s + dur.get(id));
      walk();
      used.delete(id);
      ends.delete(id);
    }
  };
  walk();
  return best;
}

test('random DAGs (n<=9) match topological enumeration and yield valid orders', () => {
  const rng = mulberry32(20261004);
  for (let trial = 0; trial < 60; trial++) {
    const n = 2 + Math.floor(rng() * 8); // 2..9
    const ids = [];
    const p = new Planner();
    for (let i = 0; i < n; i++) {
      const id = `t${i}`;
      ids.push(id);
      p.addTask(id, 1 + Math.floor(rng() * 9), Math.floor(rng() * 5));
    }
    const perm = [...ids];
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rng() < 0.35) {
          edges.push([perm[i], perm[j]]);
          p.dep(perm[i], perm[j]);
        }
      }
    }
    const budget = p.totalCost();
    const r = p.schedule(budget);
    assert.equal(r.status, 'OK', `trial ${trial}`);

    // order is a valid topological order
    const pos = new Map(r.order.map((id, i) => [id, i]));
    assert.equal(r.order.length, n);
    for (const [a, b] of edges) assert.ok(pos.get(a) < pos.get(b), `order violates ${a}->${b}`);

    // start/end consistency with dependencies
    for (const [a, b] of edges) assert.ok(r.start[b] >= r.end[a], `${b} starts before ${a} ends`);
    for (const id of ids) assert.equal(r.end[id], r.start[id] + (r.end[id] - r.start[id]));

    // makespan matches brute-force enumeration over all topological orders
    const dur = new Map(ids.map((id) => [id, r.end[id] - r.start[id]]));
    const expected = bruteForceMakespan(ids, dur, edges);
    assert.equal(r.makespan, expected, `trial ${trial} makespan mismatch`);
  }
});

// INVALID_INPUT handling.
test('invalid inputs are rejected', () => {
  const p = new Planner();
  assert.throws(() => p.addTask('a', -1, 0), /dur/);
  assert.throws(() => p.addTask('a', 1, NaN), /cost/);
  assert.throws(() => p.addTask('', 1, 1), /id/);
  p.addTask('a', 1, 1);
  assert.throws(() => p.addTask('a', 1, 1), /duplicate/);
  assert.throws(() => p.dep('a', 'ghost'), /unknown task/);
  assert.throws(() => p.groupEnd(), /group_end/);
  assert.equal(p.schedule(-5).status, 'INVALID_INPUT');
  assert.equal(p.schedule(Infinity).status, 'INVALID_INPUT');
});

test('duplicate dep is idempotent', () => {
  const p = new Planner();
  p.addTask('a', 1, 1);
  p.addTask('b', 1, 1);
  p.dep('a', 'b');
  p.dep('a', 'b');
  const r = p.schedule(2);
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.order, ['a', 'b']);
});

// CLI end-to-end over JSONL.
test('CLI processes JSONL commands end to end', () => {
  const lines = [
    { op: 'add_task', id: 'a', dur: 3, cost: 10 },
    { op: 'add_task', id: 'b', dur: 4, cost: 20 },
    { op: 'add_task', id: 'c', dur: 2, cost: 5 },
    { op: 'dep', a: 'a', b: 'c' },
    { op: 'dep', a: 'b', b: 'c' },
    { op: 'group_begin' },
    { op: 'add_task', id: 'd', dur: 1, cost: 100 },
    { op: 'group_end' },
    { op: 'commit' },
    { op: 'schedule', budget: 200 },
    { op: 'rollback', level: 0 },
    { op: 'schedule', budget: 35 },
    { op: 'schedule', budget: 34 },
    { op: 'rollback', level: 9 },
    { op: 'dep', a: 'a', b: 'nope' },
    'not json',
  ];
  const input = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
  const out = runLines(input);
  assert.equal(out.length, lines.length);
  assert.ok(out.slice(0, 9).every((o) => o.status === 'OK'));
  assert.equal(out[9].status, 'OK');
  assert.equal(out[9].total_cost, 135);
  assert.equal(out[10].status, 'OK'); // rollback to level 0
  assert.equal(out[11].status, 'OK'); // d rolled back, cost back to 35
  assert.equal(out[11].total_cost, 35);
  assert.equal(out[11].makespan, 6);
  assert.equal(out[12].status, 'INFEASIBLE');
  assert.equal(out[13].status, 'ROLLBACK_RANGE');
  assert.equal(out[14].status, 'INVALID_INPUT');
  assert.equal(out[15].status, 'INVALID_INPUT');
});

test('CLI reports CYCLE with SCCs and suggestions', () => {
  const lines = [
    { op: 'add_task', id: 'x', dur: 2, cost: 5 },
    { op: 'add_task', id: 'y', dur: 3, cost: 7 },
    { op: 'dep', a: 'x', b: 'y' },
    { op: 'dep', a: 'y', b: 'x' },
    { op: 'schedule', budget: 100 },
  ];
  const input = lines.map((l) => JSON.stringify(l));
  const out = runLines(input);
  const last = out[out.length - 1];
  assert.equal(last.status, 'CYCLE');
  assert.deepEqual(last.sccs, [['x', 'y']]);
  assert.deepEqual(last.break_suggestions, [
    { edge: ['x', 'y'], cost: 5 },
    { edge: ['y', 'x'], cost: 7 },
  ]);
});
