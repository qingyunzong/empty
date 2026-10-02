'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { solve } = require('../src/solver');

const small = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'examples', 'small.json'), 'utf8')
);

function travelOf(model) {
  const table = model.travel || {};
  return (a, b) => {
    if (a === b) return 0;
    if (table[a] && table[a][b] !== undefined) return table[a][b];
    if (table[b] && table[b][a] !== undefined) return table[b][a];
    return 0;
  };
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i += 1) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const tail of permutations(rest)) yield [arr[i], ...tail];
  }
}

// Exact brute force: enumerate every qualified person assignment and every
// per-person task order, schedule each order as early as possible, and take
// the lexicographic optimum of (makespan, totalTravel).
function bruteForce(model) {
  const travel = travelOf(model);
  const qualified = model.tasks.map((t) =>
    model.inspectors
      .map((p, pi) => ({ p, pi }))
      .filter(({ p }) => t.skills.every((s) => p.skills.includes(s)))
      .map(({ pi }) => pi)
  );
  let best = null;
  const assignment = new Array(model.tasks.length).fill(-1);

  function scheduleOrder(order) {
    // Tight schedule for one inspector's task order.
    let prevEnd = 0;
    let prevZone = null;
    let travelSum = 0;
    for (const ti of order) {
      const t = model.tasks[ti];
      const trav = prevZone === null ? 0 : travel(prevZone, t.zone);
      const start = Math.max(t.window.start, prevEnd + trav);
      if (start + t.duration > t.window.end) return null;
      prevEnd = start + t.duration;
      prevZone = t.zone;
      travelSum += trav;
    }
    return { end: prevEnd, travel: travelSum };
  }

  function combine(personOrders, idx, accEnd, accTravel) {
    if (accEnd > 0 || idx > 0) {
      if (best && accEnd > best.makespan) return; // cannot improve
    }
    if (idx === personOrders.length) {
      if (
        !best ||
        accEnd < best.makespan ||
        (accEnd === best.makespan && accTravel < best.totalTravel)
      ) {
        best = { makespan: accEnd, totalTravel: accTravel };
      }
      return;
    }
    for (const sched of personOrders[idx]) {
      combine(
        personOrders,
        idx + 1,
        Math.max(accEnd, sched.end),
        accTravel + sched.travel
      );
    }
  }

  function enumerateAssignments(ti) {
    if (ti === model.tasks.length) {
      const perPerson = model.inspectors.map(() => []);
      assignment.forEach((pi, taskIdx) => perPerson[pi].push(taskIdx));
      const personOrders = [];
      for (const list of perPerson) {
        const options = [];
        for (const order of permutations(list)) {
          const sched = scheduleOrder(order);
          if (sched) options.push(sched);
        }
        if (options.length === 0) return; // infeasible assignment
        personOrders.push(options);
      }
      combine(personOrders, 0, 0, 0);
      return;
    }
    for (const pi of qualified[ti]) {
      assignment[ti] = pi;
      enumerateAssignments(ti + 1);
    }
  }

  enumerateAssignments(0);
  return best;
}

// Independent feasibility checker for a solver-produced assignment list.
function checkFeasible(model, result) {
  const travel = travelOf(model);
  const byTask = new Map(result.assignments.map((a) => [a.task, a]));
  assert.equal(byTask.size, model.tasks.length, 'every task assigned exactly once');
  const inspectors = new Map(model.inspectors.map((p) => [p.id, p]));
  for (const t of model.tasks) {
    const a = byTask.get(t.id);
    assert.ok(a, `task ${t.id} assigned`);
    const person = inspectors.get(a.person);
    assert.ok(person, `inspector ${a.person} exists`);
    for (const s of t.skills) {
      assert.ok(person.skills.includes(s), `${a.person} has skill ${s}`);
    }
    assert.ok(a.start >= t.window.start, `${t.id} starts inside window`);
    assert.ok(a.start + t.duration <= t.window.end, `${t.id} ends inside window`);
    assert.equal(a.end, a.start + t.duration);
  }
  const byPerson = new Map();
  for (const a of result.assignments) {
    if (!byPerson.has(a.person)) byPerson.set(a.person, []);
    byPerson.get(a.person).push(a);
  }
  let totalTravel = 0;
  for (const list of byPerson.values()) {
    list.sort((x, y) => x.start - y.start);
    for (let k = 1; k < list.length; k += 1) {
      const prev = list[k - 1];
      const cur = list[k];
      const trav = travel(prev.zone, cur.zone);
      assert.ok(
        cur.start >= prev.end + trav,
        `no overlap: ${prev.task} -> ${cur.task} on ${cur.person}`
      );
      totalTravel += trav;
    }
  }
  const makespan = Math.max(...result.assignments.map((a) => a.end));
  assert.equal(result.makespan, makespan);
  assert.equal(result.totalTravel, totalTravel);
}

test('3 inspectors x 4 tasks matches brute-force optimum', () => {
  const result = solve(small, { budget: 100000 });
  assert.equal(result.status, 'optimal');
  checkFeasible(small, result);
  const expected = bruteForce(small);
  assert.ok(expected, 'brute force found a feasible plan');
  assert.equal(result.makespan, expected.makespan, 'makespan is minimal');
  assert.equal(
    result.totalTravel,
    expected.totalTravel,
    'total travel is minimal among min-makespan plans'
  );
});

test('task with a skill nobody has yields an infeasible conflict proof', () => {
  const model = {
    inspectors: [
      { id: 'amy', skills: ['electrical'] },
      { id: 'bob', skills: ['plumbing'] },
    ],
    tasks: [
      { id: 't1', skills: ['electrical'], duration: 2, window: { start: 0, end: 6 }, zone: 'Z1' },
      { id: 't5', skills: ['thermal-imaging'], duration: 1, window: { start: 0, end: 4 }, zone: 'Z2' },
    ],
    travel: { Z1: { Z2: 1 } },
  };
  const result = solve(model, { budget: 1000 });
  assert.equal(result.status, 'infeasible');
  assert.equal(result.conflict.type, 'skill');
  assert.equal(result.conflict.task, 't5');
  assert.deepEqual(result.conflict.skills, ['thermal-imaging']);
  assert.match(result.conflict.detail, /t5/);
});

test('window too small for the duration yields a window conflict', () => {
  const model = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [
      { id: 't1', skills: ['electrical'], duration: 5, window: { start: 0, end: 3 }, zone: 'Z1' },
    ],
  };
  const result = solve(model, { budget: 100 });
  assert.equal(result.status, 'infeasible');
  assert.equal(result.conflict.type, 'window');
  assert.equal(result.conflict.task, 't1');
});

test('overlapping tasks forced onto one inspector yield a sequence conflict', () => {
  const model = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [
      { id: 't1', skills: ['electrical'], duration: 3, window: { start: 0, end: 4 }, zone: 'Z1' },
      { id: 't2', skills: ['electrical'], duration: 3, window: { start: 0, end: 4 }, zone: 'Z1' },
    ],
  };
  const result = solve(model, { budget: 1000 });
  assert.equal(result.status, 'infeasible');
  assert.equal(result.conflict.type, 'sequence');
  assert.equal(result.conflict.person, 'amy');
  assert.deepEqual(result.conflict.tasks.sort(), ['t1', 't2']);
});

test('budget threshold: unknown below, optimal at and above', () => {
  const full = solve(small, { budget: Number.MAX_SAFE_INTEGER });
  assert.equal(full.status, 'optimal');
  const needed = full.stats.branches;
  assert.ok(needed > 0, 'search actually branches');

  const exact = solve(small, { budget: needed });
  assert.equal(exact.status, 'optimal');
  assert.equal(exact.makespan, full.makespan);
  assert.equal(exact.totalTravel, full.totalTravel);

  const short = solve(small, { budget: needed - 1 });
  assert.equal(short.status, 'unknown');
  assert.ok(Array.isArray(short.pending));
  assert.ok(short.pending.length > 0, 'pending lists undecided tasks');
  for (const id of short.pending) {
    assert.ok(
      small.tasks.some((t) => t.id === id),
      `pending task ${id} is a real task`
    );
  }

  const zero = solve(small, { budget: 0 });
  assert.equal(zero.status, 'unknown');
  assert.deepEqual(
    zero.pending.sort(),
    small.tasks.map((t) => t.id).sort(),
    'with zero budget every task is still undecided'
  );
});
