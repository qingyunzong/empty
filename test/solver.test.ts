import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { Problem, UNSERVED, evaluate, normalize } from '../src/model';
import { Solver, solve } from '../src/solver';
import { bruteForce } from '../src/brute';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProblem(rand: () => number): Problem {
  const users = 1 + Math.floor(rand() * 6); // 1..6
  const tierCount = 1 + Math.floor(rand() * 4); // 1..4
  const tiers = Array.from({ length: tierCount }, () => ({
    r1: Math.floor(rand() * 7),
    r2: Math.floor(rand() * 7),
    benefit: Math.floor(rand() * 16),
  }));
  const p: Problem = {
    users,
    tiers,
    budget1: Math.floor(rand() * 21),
    budget2: Math.floor(rand() * 21),
    pairBonuses: [],
    constraints: [],
  };
  for (let i = 0; i < users; i++) {
    for (let j = i + 1; j < users; j++) {
      if (rand() < 0.4) {
        p.pairBonuses!.push({
          i, j,
          a: Math.floor(rand() * tierCount),
          b: Math.floor(rand() * tierCount),
          bonus: Math.floor(rand() * 16) - 5, // 含负收益
        });
      }
      if (rand() < 0.25) {
        p.constraints!.push({ kind: rand() < 0.5 ? 'same' : 'diff', i, j });
      }
    }
  }
  return p;
}

test('solver matches brute force on randomized small problems', () => {
  const rand = mulberry32(20261006);
  for (let k = 0; k < 60; k++) {
    const p = randomProblem(rand);
    const expected = bruteForce(p);
    const got = solve(p);
    equal(got.benefit, expected.benefit, `benefit mismatch on case ${k}`);
    deepEqual(got.assignment, expected.assignment, `assignment mismatch on case ${k}`);
    equal(got.used1, expected.used1);
    equal(got.used2, expected.used2);
    ok(got.used1 <= p.budget1 && got.used2 <= p.budget2, `budget violated on case ${k}`);
  }
});

test('hand-checked tiny example', () => {
  const p: Problem = {
    users: 2,
    tiers: [
      { r1: 2, r2: 0, benefit: 3 },
      { r1: 5, r2: 1, benefit: 8 },
    ],
    budget1: 7,
    budget2: 1,
    pairBonuses: [{ i: 0, j: 1, a: 1, b: 1, bonus: 4 }],
  };
  // 都取档1：收益 8+8+4=20，用量 (10,2) 超预算；
  // 用户0档1+用户1档0：11；都取档0：6；最优为 档1+档0 或 档0+档1 = 11。
  // 高档人数相同，取向量小者：用户0档0、用户1档1 -> [0,1]。
  const got = solve(p);
  equal(got.benefit, 11);
  deepEqual(got.assignment, [0, 1]);
  equal(got.used1, 7);
  equal(got.used2, 1);
});

test('tie-break: more users at the highest tier wins', () => {
  const p: Problem = {
    users: 1,
    tiers: [
      { r1: 1, r2: 0, benefit: 5 },
      { r1: 1, r2: 0, benefit: 5 },
    ],
    budget1: 1,
    budget2: 0,
  };
  // [0] 与 [1] 收益相同，[1] 高档人数更多。
  deepEqual(solve(p).assignment, [1]);
});

test('tie-break: smaller assignment vector wins', () => {
  const p: Problem = {
    users: 2,
    tiers: [{ r1: 1, r2: 0, benefit: 5 }],
    budget1: 1,
    budget2: 0,
  };
  // [0,-1] 与 [-1,0] 收益、档分布相同，字典序 [-1,0] 更小。
  deepEqual(solve(p).assignment, [UNSERVED, 0]);
});

test('users may be left unserved when budget is zero', () => {
  const p: Problem = {
    users: 3,
    tiers: [{ r1: 1, r2: 1, benefit: 10 }],
    budget1: 0,
    budget2: 0,
  };
  const got = solve(p);
  equal(got.benefit, 0);
  deepEqual(got.assignment, [UNSERVED, UNSERVED, UNSERVED]);
});

test('same-tier and diff-tier constraints are enforced', () => {
  const base: Problem = {
    users: 2,
    tiers: [
      { r1: 1, r2: 0, benefit: 6 },
      { r1: 2, r2: 0, benefit: 10 },
    ],
    budget1: 3,
    budget2: 0,
  };
  // 无约束：[1,1] 超预算（4>3），最优为一人档1一人档0，收益 16。
  deepEqual(solve(base).assignment, [0, 1]);
  // 必须分离档：与无约束一致。
  deepEqual(solve({ ...base, constraints: [{ kind: 'diff', i: 0, j: 1 }] }).assignment, [0, 1]);
  // 必须同档：[1,1] 超预算；[0,0] 收益 12 优于只服务一人（10）。
  deepEqual(solve({ ...base, constraints: [{ kind: 'same', i: 0, j: 1 }] }).assignment, [0, 0]);
});

test('pairwise combo benefit changes the optimum', () => {
  const p: Problem = {
    users: 2,
    tiers: [
      { r1: 1, r2: 0, benefit: 6 },
      { r1: 1, r2: 0, benefit: 7 },
    ],
    budget1: 2,
    budget2: 0,
    pairBonuses: [{ i: 0, j: 1, a: 0, b: 0, bonus: 5 }],
  };
  // 都取档1：14；都取档0：12+5=17。
  const got = solve(p);
  equal(got.benefit, 17);
  deepEqual(got.assignment, [0, 0]);
});

test('evaluate agrees with incremental solver accounting', () => {
  const rand = mulberry32(7);
  for (let k = 0; k < 20; k++) {
    const p = randomProblem(rand);
    const np = normalize(p);
    const got = solve(p);
    const ev = evaluate(np, got.assignment);
    equal(ev.benefit, got.benefit);
    equal(ev.used1, got.used1);
    equal(ev.used2, got.used2);
  }
});

test('solver node count is deterministic across identical runs', () => {
  const rand = mulberry32(99);
  const p = randomProblem(rand);
  const a = new Solver(p); a.run();
  const b = new Solver(p); b.run();
  equal(a.nodeCount, b.nodeCount);
  deepEqual(a.getBest(), b.getBest());
});
