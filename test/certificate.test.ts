import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { Problem, UNSERVED } from '../src/model';
import { solve } from '../src/solver';
import { verifySolution } from '../src/certificate';

const problem: Problem = {
  users: 4,
  tiers: [
    { r1: 2, r2: 1, benefit: 3 },
    { r1: 4, r2: 2, benefit: 8 },
  ],
  budget1: 10,
  budget2: 6,
  pairBonuses: [{ i: 0, j: 1, a: 1, b: 1, bonus: 5 }],
  constraints: [
    { kind: 'same', i: 0, j: 1 },
    { kind: 'diff', i: 2, j: 3 },
  ],
};

test('solver output carries one certificate per budget and per constraint, all satisfied', () => {
  const best = solve(problem);
  const v = verifySolution(problem, best.assignment);
  ok(v.ok, v.certificates.filter((c) => !c.ok).map((c) => c.detail).join('\n'));
  equal(v.certificates.length, 2 + problem.constraints!.length);
  equal(v.certificates.filter((c) => c.kind === 'budget').length, 2);
  equal(v.certificates.filter((c) => c.kind === 'constraint').length, 2);
  equal(v.benefit, best.benefit);
  equal(v.used1, best.used1);
  equal(v.used2, best.used2);
});

test('usage output respects both budgets', () => {
  const best = solve(problem);
  ok(best.used1 <= problem.budget1);
  ok(best.used2 <= problem.budget2);
});

test('tampered assignment fails verification with a precise certificate', () => {
  // 手工构造违反 diff(2,3) 的解：用户2、3 同档（预算内：r1=8<=10, r2=4<=6）。
  const bad = [0, 0, 0, 0];
  const v = verifySolution(problem, bad);
  ok(!v.ok);
  const failed = v.certificates.filter((c) => !c.ok);
  equal(failed.length, 1);
  equal(failed[0].kind, 'constraint');
  if (failed[0].kind === 'constraint') equal(failed[0].index, 1);
  ok(failed[0].detail.includes('VIOLATED'));
});

test('over-budget assignment fails the budget certificate', () => {
  const v = verifySolution(problem, [1, 1, 1, 1]); // r1 = 16 > 10
  ok(!v.ok);
  const budgetCerts = v.certificates.filter((c) => c.kind === 'budget');
  ok(budgetCerts.some((c) => !c.ok && c.resource === 'r1'));
});

test('unserved users make constraints vacuously satisfied', () => {
  const p: Problem = {
    users: 2,
    tiers: [{ r1: 1, r2: 1, benefit: 5 }],
    budget1: 1,
    budget2: 1,
    constraints: [{ kind: 'same', i: 0, j: 1 }],
  };
  const v = verifySolution(p, [0, UNSERVED]);
  ok(v.ok);
  const c = v.certificates.find((x) => x.kind === 'constraint')!;
  ok(c.detail.includes('vacuously satisfied'));
});

test('certificate details are human-readable and enumerate every constraint', () => {
  const best = solve(problem);
  const v = verifySolution(problem, best.assignment);
  const details = v.certificates.map((c) => c.detail);
  ok(details.some((d) => d.startsWith('resource r1:')));
  ok(details.some((d) => d.startsWith('resource r2:')));
  ok(details.some((d) => d.startsWith('constraint#0 same(0,1):')));
  ok(details.some((d) => d.startsWith('constraint#1 diff(2,3):')));
});
