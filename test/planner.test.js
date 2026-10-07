import test from 'node:test';
import assert from 'node:assert/strict';
import { Planner, STATUS } from '../src/planner.js';
import { runJsonl } from '../src/cliCore.js';

function ok(result) {
  assert.equal(result.status, STATUS.OK, JSON.stringify(result));
  return result;
}

// ---------- Acceptance 1: chain and parallel durations ----------

test('chain: serial earliest-start schedule', () => {
  const p = new Planner();
  ok(p.addTask('a', 2, 1));
  ok(p.addTask('b', 3, 1));
  ok(p.addTask('c', 4, 1));
  ok(p.dep('a', 'b'));
  ok(p.dep('b', 'c'));
  const r = p.schedule(100);
  assert.equal(r.status, STATUS.OK);
  assert.deepEqual(r.order, ['a', 'b', 'c']);
  assert.deepEqual(r.start, { a: 0, b: 2, c: 5 });
  assert.deepEqual(r.end, { a: 2, b: 5, c: 9 });
  assert.equal(r.makespan, 9);
  assert.equal(r.total_cost, 3);
});

test('parallel: independent tasks all start at 0, makespan = max dur', () => {
  const p = new Planner();
  ok(p.addTask('a', 2, 1));
  ok(p.addTask('b', 3, 1));
  ok(p.addTask('c', 4, 1));
  const r = p.schedule(100);
  assert.equal(r.status, STATUS.OK);
  assert.deepEqual(r.start, { a: 0, b: 0, c: 0 });
  assert.equal(r.makespan, 4);
  // tie-break: smaller duration first, then id
  assert.deepEqual(r.order, ['a', 'b', 'c']);
});

test('diamond: join waits for the slowest predecessor', () => {
  const p = new Planner();
  ok(p.addTask('a', 1, 1));
  ok(p.addTask('b', 5, 1));
  ok(p.addTask('c', 2, 1));
  ok(p.addTask('d', 3, 1));
  ok(p.dep('a', 'b'));
  ok(p.dep('a', 'c'));
  ok(p.dep('b', 'd'));
  ok(p.dep('c', 'd'));
  const r = p.schedule(100);
  assert.equal(r.status, STATUS.OK);
  assert.equal(r.start.d, 6); // max(end b=6, end c=3)
  assert.equal(r.end.d, 9);
});

// ---------- Acceptance 2: cycle compression ordered with external nodes ----------

test('cycle: SCC compressed, external nodes ordered around it', () => {
  const p = new Planner();
  ok(p.addTask('x', 1, 1));
  ok(p.addTask('a', 2, 4));
  ok(p.addTask('b', 3, 2));
  ok(p.addTask('c', 4, 6));
  ok(p.addTask('y', 5, 1));
  ok(p.dep('x', 'a'));
  ok(p.dep('a', 'b'));
  ok(p.dep('b', 'c'));
  ok(p.dep('c', 'a')); // cycle a->b->c->a
  ok(p.dep('b', 'y'));
  const r = p.schedule(100);
  assert.equal(r.status, STATUS.CYCLE);
  assert.deepEqual(r.sccs, [['a', 'b', 'c']]);
  // external x before the block, y after it
  assert.deepEqual(r.order, ['x', 'a', 'b', 'c', 'y']);
  assert.equal(r.start.x, 0);
  assert.equal(r.end.x, 1);
  assert.equal(r.start.a, 1); // block starts after x
  assert.equal(r.end.c, 10); // block dur = 2+3+4 = 9
  assert.equal(r.start.y, 10);
  assert.equal(r.end.y, 15);
  assert.equal(r.makespan, 15);
  // break-edge suggestions: internal edges priced by target cost, ascending
  assert.deepEqual(r.break_edges, [
    { from: 'a', to: 'b', cost: 2 },
    { from: 'c', to: 'a', cost: 4 },
    { from: 'b', to: 'c', cost: 6 },
  ]);
  // every task still present
  assert.equal(r.order.length, 5);
});

test('cycle: self-loop reported as CYCLE', () => {
  const p = new Planner();
  ok(p.addTask('a', 1, 1));
  ok(p.dep('a', 'a'));
  const r = p.schedule(10);
  assert.equal(r.status, STATUS.CYCLE);
  assert.deepEqual(r.sccs, [['a']]);
  assert.deepEqual(r.break_edges, [{ from: 'a', to: 'a', cost: 1 }]);
});

// ---------- Acceptance 3: budget boundary ----------

test('budget: exact budget feasible, one less INFEASIBLE, no task dropped', () => {
  const build = () => {
    const p = new Planner();
    ok(p.addTask('a', 2, 30));
    ok(p.addTask('b', 3, 50));
    ok(p.addTask('c', 1, 20));
    ok(p.dep('a', 'b'));
    return p;
  };
  const feasible = build().schedule(100); // total_cost = 100
  assert.equal(feasible.status, STATUS.OK);
  assert.equal(feasible.total_cost, 100);

  const infeasible = build().schedule(99);
  assert.equal(infeasible.status, STATUS.INFEASIBLE);
  assert.equal(infeasible.total_cost, 100);
  // tasks are never dropped to fit the budget
  assert.deepEqual([...infeasible.order].sort(), ['a', 'b', 'c']);
});

// ---------- Acceptance 4: three-level groups, rollback restores state ----------

test('groups: three-level rollback restores deps, cost and committed flags', () => {
  const p = new Planner();
  ok(p.addTask('base', 1, 10));

  ok(p.groupBegin()); // level 1
  ok(p.addTask('t1', 2, 20));
  ok(p.dep('base', 't1'));

  ok(p.groupBegin()); // level 2
  ok(p.addTask('t2', 3, 30));
  ok(p.dep('t1', 't2'));

  ok(p.groupBegin()); // level 3
  ok(p.addTask('t3', 4, 40));
  ok(p.dep('t2', 't3'));

  assert.equal(p.depth, 3);
  ok(p.commit());
  assert.equal(p.isCommitted(1), true);
  assert.equal(p.isCommitted(2), true);
  assert.equal(p.isCommitted(3), true);

  const full = p.schedule(1000);
  assert.equal(full.total_cost, 100);
  assert.equal(full.order.length, 4);

  // rollback to level 2: everything from level 2 onward is undone
  // (t2, t3 and their deps disappear); level 2 is fresh and uncommitted
  ok(p.rollback(2));
  assert.equal(p.depth, 2);
  assert.equal(p.taskCount, 2);
  assert.equal(p.depCount, 1);
  assert.equal(p.isCommitted(2), false);
  const after2 = p.schedule(1000);
  assert.equal(after2.total_cost, 30);

  // rollback to level 1
  ok(p.rollback(1));
  assert.equal(p.taskCount, 1);
  assert.equal(p.depCount, 0);
  assert.equal(p.schedule(1000).total_cost, 10);

  // rollback to base level resets to the initial empty state
  ok(p.rollback(0));
  assert.equal(p.taskCount, 0);
  assert.equal(p.depCount, 0);
  assert.equal(p.schedule(1000).total_cost, 0);
});

test('groups: commit then rollback restores uncommitted flags', () => {
  const p = new Planner();
  ok(p.addTask('base', 1, 1));
  ok(p.groupBegin());
  ok(p.addTask('a', 1, 1));
  ok(p.commit());
  assert.equal(p.isCommitted(1), true);
  ok(p.rollback(1)); // snapshot was taken before level-1 ops, flags uncommitted
  assert.equal(p.isCommitted(1), false);
  assert.equal(p.taskCount, 1);
});

test('groups: out-of-range rollback returns ROLLBACK_RANGE and keeps state', () => {
  const p = new Planner();
  ok(p.addTask('a', 1, 5));
  ok(p.groupBegin());
  ok(p.addTask('b', 2, 7));
  const before = p.schedule(100);

  assert.equal(p.rollback(5).status, STATUS.ROLLBACK_RANGE);
  assert.equal(p.rollback(-1).status, STATUS.ROLLBACK_RANGE);
  assert.equal(p.rollback(2).status, STATUS.ROLLBACK_RANGE); // only levels 0..1 exist
  assert.equal(p.rollback(1.5).status, STATUS.INVALID_INPUT);

  // state unchanged
  assert.equal(p.taskCount, 2);
  assert.equal(p.depth, 1);
  assert.deepEqual(p.schedule(100), before);

  // rollback(1) discards the level-1 snapshot; a second rollback(1) still works
  // (snapshot at level 1 is retained), but rollback(2) stays out of range.
  ok(p.rollback(1));
  assert.equal(p.taskCount, 1);
  assert.equal(p.rollback(2).status, STATUS.ROLLBACK_RANGE);
});

test('groups: group_end without begin is INVALID_INPUT', () => {
  const p = new Planner();
  assert.equal(p.groupEnd().status, STATUS.INVALID_INPUT);
  ok(p.groupBegin());
  ok(p.groupEnd());
  assert.equal(p.groupEnd().status, STATUS.INVALID_INPUT);
});

// ---------- Acceptance 5: cross-check against topological enumeration (n <= 9) ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function enumerateBestOrder(ids, durs, preds) {
  // brute-force all topological orders; keep the element-wise minimal one
  // under the (duration, id) comparator
  const indeg = new Map(ids.map((id) => [id, preds[id].size]));
  let best = null;
  const current = [];
  const better = (candidate, incumbent) => {
    for (let i = 0; i < candidate.length; i += 1) {
      const ca = candidate[i];
      const cb = incumbent[i];
      if (durs[ca] !== durs[cb]) return durs[ca] < durs[cb];
      if (ca !== cb) return ca < cb;
    }
    return false;
  };
  const ready = ids.filter((id) => indeg.get(id) === 0);
  const rec = () => {
    if (current.length === ids.length) {
      if (best === null || better(current, best)) best = [...current];
      return;
    }
    for (let i = ready.length - 1; i >= 0; i -= 1) {
      const id = ready[i];
      ready.splice(i, 1);
      current.push(id);
      const released = [];
      for (const other of ids) {
        if (preds[other].has(id)) {
          indeg.set(other, indeg.get(other) - 1);
          if (indeg.get(other) === 0) {
            ready.push(other);
            released.push(other);
          }
        }
      }
      rec();
      for (const other of released) ready.splice(ready.indexOf(other), 1);
      for (const other of ids) {
        if (preds[other].has(id)) indeg.set(other, indeg.get(other) + 1);
      }
      current.pop();
      ready.splice(i, 0, id);
    }
  };
  rec();
  return best;
}

test('order matches brute-force topological enumeration for n <= 9', () => {
  const rand = mulberry32(20261007);
  for (let n = 2; n <= 9; n += 1) {
    for (let trial = 0; trial < 6; trial += 1) {
      const ids = Array.from({ length: n }, (_, i) => `t${i}`);
      const durs = {};
      const p = new Planner();
      for (const id of ids) {
        durs[id] = 1 + Math.floor(rand() * 5);
        ok(p.addTask(id, durs[id], 1));
      }
      // random DAG: shuffle a permutation, edges only earlier -> later
      const perm = [...ids];
      for (let i = perm.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const pos = new Map(perm.map((id, i) => [id, i]));
      const preds = {};
      for (const id of ids) preds[id] = new Set();
      for (const a of ids) {
        for (const b of ids) {
          if (pos.get(a) < pos.get(b) && rand() < 0.35) {
            ok(p.dep(a, b));
            preds[b].add(a);
          }
        }
      }
      const r = p.schedule(Number.MAX_SAFE_INTEGER);
      assert.equal(r.status, STATUS.OK);
      const expected = enumerateBestOrder(ids, durs, preds);
      assert.deepEqual(r.order, expected, `n=${n} trial=${trial}`);
      // dependency consistency of start/end
      for (const b of ids) {
        for (const a of preds[b]) {
          assert.ok(r.end[a] <= r.start[b], `${a} must end before ${b} starts`);
        }
      }
    }
  }
});

// ---------- invalid input handling ----------

test('invalid inputs rejected with INVALID_INPUT', () => {
  const p = new Planner();
  assert.equal(p.addTask('', 1, 1).status, STATUS.INVALID_INPUT);
  assert.equal(p.addTask('a', -1, 1).status, STATUS.INVALID_INPUT);
  assert.equal(p.addTask('a', 1, Number.NaN).status, STATUS.INVALID_INPUT);
  ok(p.addTask('a', 1, 1));
  assert.equal(p.addTask('a', 1, 1).status, STATUS.INVALID_INPUT); // duplicate
  assert.equal(p.dep('a', 'ghost').status, STATUS.INVALID_INPUT);
  assert.equal(p.dep('ghost', 'a').status, STATUS.INVALID_INPUT);
  assert.equal(p.schedule(-5).status, STATUS.INVALID_INPUT);
  assert.equal(p.schedule(Number.NaN).status, STATUS.INVALID_INPUT);
  ok(p.dep('a', 'a')); // self-loop allowed, surfaces as CYCLE
  ok(p.dep('a', 'a')); // duplicate dep is idempotent
  assert.equal(p.depCount, 1);
});

// ---------- CLI end-to-end ----------

test('cli: JSONL round trip including rollback and schedule', () => {
  const input = [
    JSON.stringify({ op: 'add_task', id: 'a', dur: 2, cost: 30 }),
    JSON.stringify({ op: 'add_task', id: 'b', dur: 3, cost: 50 }),
    JSON.stringify({ op: 'add_task', id: 'c', dur: 1, cost: 20 }),
    JSON.stringify({ op: 'dep', a: 'a', b: 'b' }),
    JSON.stringify({ op: 'group_begin' }),
    JSON.stringify({ op: 'dep', a: 'b', b: 'c' }),
    JSON.stringify({ op: 'rollback', level: 1 }),
    JSON.stringify({ op: 'rollback', level: 9 }),
    JSON.stringify({ op: 'schedule', budget: 100 }),
    JSON.stringify({ op: 'schedule', budget: 99 }),
    'not json',
    JSON.stringify({ op: 'bogus' }),
  ].join('\n');
  const out = runJsonl(input).map((line) => JSON.parse(line));

  assert.equal(out.length, 12);
  assert.equal(out[3].status, STATUS.OK); // dep
  assert.equal(out[5].status, STATUS.OK); // dep inside group
  assert.equal(out[6].status, STATUS.OK); // rollback(1) removes dep b->c
  assert.equal(out[7].status, STATUS.ROLLBACK_RANGE);
  const sched = out[8];
  assert.equal(sched.status, STATUS.OK);
  assert.deepEqual(sched.order, ['a', 'b', 'c']);
  assert.equal(sched.start.c, 0); // c independent after rollback
  assert.equal(sched.total_cost, 100);
  assert.equal(out[9].status, STATUS.INFEASIBLE);
  assert.equal(out[10].status, STATUS.INVALID_INPUT);
  assert.equal(out[11].status, STATUS.INVALID_INPUT);
});
