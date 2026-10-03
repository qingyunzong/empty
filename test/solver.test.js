import test from 'node:test';
import assert from 'node:assert/strict';
import { Rational } from '../src/rational.js';
import { solve, idCompare } from '../src/solver.js';

// ---- independent brute-force oracle (own fraction arithmetic) ----
function frac(n, d = 1n) {
  if (d < 0n) { n = -n; d = -d; }
  const g = (a, b) => (b === 0n ? a : g(b, a % b));
  const q = g(n < 0n ? -n : n, d) || 1n;
  return [n / q, d / q];
}
const fadd = (a, b) => frac(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const fcmp = (a, b) => {
  const l = a[0] * b[1], r = b[0] * a[1];
  return l < r ? -1 : l > r ? 1 : 0;
};
const toFrac = (r) => frac(r.num, r.den);

function bruteForce(tasks, budget, limit) {
  const n = tasks.length;
  const B = toFrac(budget);
  const L = toFrac(limit);
  let best = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    const chosen = new Set();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) chosen.add(tasks[i].id);
    // precedence closure: repeatedly expand until stable
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of tasks) {
        if (chosen.has(t.id)) {
          for (const d of t.deps) if (!chosen.has(d)) { chosen.add(d); grew = true; }
        }
      }
    }
    let bits = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
    if (chosen.size !== bits) continue; // mask was not precedence-closed
    let p = frac(0n), ch = frac(0n), dh = frac(0n);
    for (const t of tasks) {
      if (chosen.has(t.id)) {
        p = fadd(p, toFrac(t.priority));
        ch = fadd(ch, toFrac(t.ch));
        dh = fadd(dh, toFrac(t.dh));
      }
    }
    if (fcmp(ch, B) > 0 || fcmp(dh, L) > 0) continue;
    const ids = [...chosen].sort(idCompare);
    if (
      best === null ||
      fcmp(p, best.p) > 0 ||
      (fcmp(p, best.p) === 0 && seqLess(ids, best.ids))
    ) {
      best = { p, ids };
    }
  }
  return best;
}

function seqLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return String(a[i]) < String(b[i]);
  }
  return a.length < b.length;
}

// seeded PRNG for reproducibility
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand, n) {
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const cl = Math.floor(rand() * 5);
    const dl = Math.floor(rand() * 4);
    tasks.push({
      id: `t${i}`,
      priority: Rational.parse(`${Math.floor(rand() * 9)}/2`),
      cl: Rational.parse(cl),
      ch: Rational.parse(cl + Math.floor(rand() * 4)),
      dl: Rational.parse(dl),
      dh: Rational.parse(dl + Math.floor(rand() * 3)),
      deps: [],
    });
  }
  // random acyclic precedence: edges only from higher index to lower index
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (rand() < 0.25) tasks[i].deps.push(tasks[j].id);
    }
  }
  const budget = Rational.parse(Math.floor(rand() * 12));
  const limit = Rational.parse(Math.floor(rand() * 10));
  return { tasks, budget, limit };
}

test('matches brute-force oracle on random instances with n<=9', () => {
  const rand = mulberry32(20261004);
  let compared = 0;
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 9); // 1..9
    const { tasks, budget, limit } = randomInstance(rand, n);
    const oracle = bruteForce(tasks, budget, limit);
    if (oracle === null) {
      assert.throws(() => solve(tasks, budget, limit), (e) => e.code === 'E_UNSAT');
      continue;
    }
    const result = solve(tasks, budget, limit);
    assert.deepEqual(result.selected, oracle.ids, `selection mismatch at iter ${iter}`);
    assert.equal(result.priority, `${oracle.p[0]}/${oracle.p[1]}`.replace(/\/1$/, ''));
    compared++;
  }
  assert.ok(compared > 250, `expected many feasible instances, got ${compared}`);
});

test('accepts selection whose worst-case cost equals the budget exactly', () => {
  const tasks = [
    { id: 'a', priority: Rational.parse(5), cl: Rational.parse('1/2'), ch: Rational.parse('3/2'), dl: Rational.parse(0), dh: Rational.parse(0), deps: [] },
    { id: 'b', priority: Rational.parse(4), cl: Rational.parse(1), ch: Rational.parse('5/2'), dl: Rational.parse(0), dh: Rational.parse(0), deps: [] },
  ];
  // worst-case cost of {a,b} = 3/2 + 5/2 = 4, exactly the budget
  const result = solve(tasks, Rational.parse(4), Rational.parse(0));
  assert.deepEqual(result.selected, ['a', 'b']);
  assert.equal(result.costInterval[1], '4');
});

test('boundary: one less than the budget excludes the tight combination', () => {
  const tasks = [
    { id: 'a', priority: Rational.parse(5), cl: Rational.parse(0), ch: Rational.parse('3/2'), dl: Rational.parse(0), dh: Rational.parse(0), deps: [] },
    { id: 'b', priority: Rational.parse(4), cl: Rational.parse(0), ch: Rational.parse('5/2'), dl: Rational.parse(0), dh: Rational.parse(0), deps: [] },
  ];
  const result = solve(tasks, Rational.parse('7/2'), Rational.parse(0));
  assert.deepEqual(result.selected, ['a']);
});

test('precedence forces ancestors into the selection', () => {
  const tasks = [
    { id: 'root', priority: Rational.parse(-10), cl: Rational.parse(0), ch: Rational.parse(1), dl: Rational.parse(0), dh: Rational.parse(0), deps: [] },
    { id: 'leaf', priority: Rational.parse(100), cl: Rational.parse(0), ch: Rational.parse(1), dl: Rational.parse(0), dh: Rational.parse(0), deps: ['root'] },
  ];
  const result = solve(tasks, Rational.parse(2), Rational.parse(0));
  assert.deepEqual(result.selected, ['leaf', 'root']);
});

test('tie-break picks lexicographically smallest id sequence', () => {
  const mk = (id) => ({ id, priority: Rational.parse(1), cl: Rational.parse(0), ch: Rational.parse(1), dl: Rational.parse(0), dh: Rational.parse(0), deps: [] });
  const result = solve([mk('b'), mk('a'), mk('c')], Rational.parse(1), Rational.parse(0));
  assert.deepEqual(result.selected, ['a']);
});

test('E_UNSAT when even the empty selection violates the budget', () => {
  assert.throws(() => solve([], Rational.parse(-1), Rational.parse(0)), (e) => e.code === 'E_UNSAT');
});

test('reports exact interval sums, unselected reasons and a certificate', () => {
  const tasks = [
    { id: 'a', priority: Rational.parse(3), cl: Rational.parse('1/2'), ch: Rational.parse(1), dl: Rational.parse(1), dh: Rational.parse(2), deps: [] },
    { id: 'b', priority: Rational.parse(1), cl: Rational.parse(0), ch: Rational.parse(9), dl: Rational.parse(0), dh: Rational.parse(1), deps: [] },
  ];
  const result = solve(tasks, Rational.parse(2), Rational.parse(3));
  assert.deepEqual(result.selected, ['a']);
  assert.deepEqual(result.costInterval, ['1/2', '1']);
  assert.deepEqual(result.durationInterval, ['1', '2']);
  assert.equal(result.unselected.b.reason, 'cost_budget');
  assert.equal(result.certificate.method, 'exact-enumeration');
  assert.equal(result.certificate.subsetsEvaluated, 4);
  assert.ok(result.certificate.feasibleCount >= 2);
});
