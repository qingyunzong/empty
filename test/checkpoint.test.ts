import { test } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Problem } from '../src/model';
import { Solver } from '../src/solver';

const DIR = join(tmpdir(), 'tier-allocator-test');
mkdirSync(DIR, { recursive: true });

const problem: Problem = {
  users: 10,
  tiers: [
    { r1: 3, r2: 2, benefit: 4 },
    { r1: 5, r2: 3, benefit: 9 },
    { r1: 8, r2: 5, benefit: 15 },
  ],
  budget1: 22,
  budget2: 15,
  pairBonuses: [
    { i: 0, j: 3, a: 2, b: 2, bonus: 6 },
    { i: 1, j: 2, a: 1, b: 0, bonus: 3 },
    { i: 4, j: 7, a: 0, b: 1, bonus: -2 },
    { i: 5, j: 6, a: 2, b: 2, bonus: 5 },
  ],
  constraints: [
    { kind: 'same', i: 0, j: 3 },
    { kind: 'diff', i: 1, j: 2 },
    { kind: 'diff', i: 8, j: 9 },
  ],
};

function tmpFile(name: string): string {
  return join(DIR, name);
}

test('pause/save/restore produces the identical result and node count', () => {
  const full = new Solver(problem);
  full.run();
  const expected = full.getBest()!;

  const file = tmpFile('cp1.json');
  if (existsSync(file)) rmSync(file);

  // 每次最多推进 37 个节点就暂停、保存、从文件恢复为新实例。
  let solver = new Solver(problem);
  let pauses = 0;
  while (!solver.isDone) {
    solver.run(solver.nodeCount + 37);
    solver.saveToFile(problem, file);
    solver = Solver.loadFromFile(problem, file);
    pauses++;
    ok(pauses < 100000, 'too many pauses, something is wrong');
  }
  ok(pauses > 1, 'expected the run to actually pause at least once');
  equal(solver.nodeCount, full.nodeCount, 'node count must match uninterrupted run');
  deepEqual(solver.getBest(), expected);
});

test('in-memory checkpoint round-trip equals uninterrupted run', () => {
  const full = new Solver(problem);
  full.run();

  let solver = new Solver(problem);
  let budget = 1;
  while (!solver.isDone) {
    solver.run(solver.nodeCount + budget);
    budget = budget * 3 + 1;
    solver = Solver.fromCheckpoint(problem, solver.toCheckpoint(problem));
  }
  equal(solver.nodeCount, full.nodeCount);
  deepEqual(solver.getBest(), full.getBest());
});

test('checkpoint file is valid JSON with complete search state', () => {
  const file = tmpFile('cp2.json');
  const solver = new Solver(problem);
  solver.run(10);
  solver.saveToFile(problem, file);
  const cp = JSON.parse(readFileSync(file, 'utf8'));
  equal(cp.version, 1);
  ok(typeof cp.problem === 'string' && cp.problem.length > 0);
  ok(Array.isArray(cp.stack) && Array.isArray(cp.choices));
  ok(typeof cp.nodes === 'number' && cp.nodes === 10);
  equal(cp.done, false);
});

test('restoring with a different problem is rejected', () => {
  const file = tmpFile('cp3.json');
  const solver = new Solver(problem);
  solver.run(5);
  solver.saveToFile(problem, file);
  const other: Problem = { ...problem, budget1: problem.budget1 + 1 };
  throws(() => Solver.loadFromFile(other, file));
});

test('running a finished solver is a no-op', () => {
  const solver = new Solver(problem);
  solver.run();
  const nodes = solver.nodeCount;
  solver.run();
  equal(solver.nodeCount, nodes);
});
