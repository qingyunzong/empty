import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, type TestStatus } from '../src/executor.ts';
import { classify, expectedStarted } from '../src/model.ts';
import { verifyAgainstModel } from '../src/verify.ts';
import type { TestCase } from '../src/graph.ts';

const tc = (id: string, ...deps: string[]): TestCase => ({ id, deps });
const allPass = () => true;
const statusOf = (summary: ReturnType<typeof execute>, id: string): TestStatus =>
  summary.results.find((r) => r.id === id)!.status;

test('cycle: only the SCC and its successors are isolated, the rest execute', () => {
  // A -> B -> C -> A is a cycle; D depends on the cycle; E, F are clean.
  const cases = [
    tc('A', 'B'),
    tc('B', 'C'),
    tc('C', 'A'),
    tc('D', 'A'),
    tc('E'),
    tc('F', 'E'),
  ];
  const summary = execute(cases, allPass);
  assert.equal(statusOf(summary, 'A'), 'isolated');
  assert.equal(statusOf(summary, 'B'), 'isolated');
  assert.equal(statusOf(summary, 'C'), 'isolated');
  assert.equal(statusOf(summary, 'D'), 'isolated');
  assert.equal(statusOf(summary, 'E'), 'passed');
  assert.equal(statusOf(summary, 'F'), 'passed');
  assert.deepEqual(summary.started, ['E', 'F']);
});

test('cycle: upstream dependencies of a cycle still execute', () => {
  const cases = [tc('root'), tc('X', 'root', 'Y'), tc('Y', 'X'), tc('Z', 'X')];
  const summary = execute(cases, allPass);
  assert.equal(statusOf(summary, 'root'), 'passed');
  assert.equal(statusOf(summary, 'X'), 'isolated');
  assert.equal(statusOf(summary, 'Y'), 'isolated');
  assert.equal(statusOf(summary, 'Z'), 'isolated');
});

test('cycle: self-loop is isolated', () => {
  const cases = [tc('self', 'self'), tc('ok')];
  const summary = execute(cases, allPass);
  assert.equal(statusOf(summary, 'self'), 'isolated');
  assert.equal(statusOf(summary, 'ok'), 'passed');
});

test('failure: cancels successors transitively but never siblings', () => {
  // bad fails; good passes. child depends on bad, sibling on good,
  // grandchild on child, mixed on both.
  const cases = [
    tc('bad'),
    tc('good'),
    tc('child', 'bad'),
    tc('sibling', 'good'),
    tc('grandchild', 'child'),
    tc('mixed', 'bad', 'good'),
  ];
  const summary = execute(cases, (id) => id !== 'bad');
  assert.equal(statusOf(summary, 'bad'), 'failed');
  assert.equal(statusOf(summary, 'good'), 'passed');
  assert.equal(statusOf(summary, 'child'), 'cancelled');
  assert.equal(statusOf(summary, 'grandchild'), 'cancelled');
  assert.equal(statusOf(summary, 'mixed'), 'cancelled');
  assert.equal(statusOf(summary, 'sibling'), 'passed');
  assert.deepEqual(summary.started, ['bad', 'good', 'sibling']);
});

test('failure: one failing root does not stop an independent branch', () => {
  const cases = [tc('a1'), tc('a2', 'a1'), tc('b1'), tc('b2', 'b1'), tc('b3', 'b2')];
  const summary = execute(cases, (id) => id !== 'a1');
  assert.equal(statusOf(summary, 'a2'), 'cancelled');
  assert.equal(statusOf(summary, 'b1'), 'passed');
  assert.equal(statusOf(summary, 'b2'), 'passed');
  assert.equal(statusOf(summary, 'b3'), 'passed');
});

test('results: stably sorted by id regardless of input order', () => {
  const base = [tc('t01'), tc('t02', 't01'), tc('t10'), tc('t03', 't02', 't10')];
  const shuffled = [...base].reverse();
  const run = (id: string) => id !== 't10';
  const a = execute(base, run);
  const b = execute(shuffled, run);
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.results.map((r) => r.id),
    ['t01', 't02', 't03', 't10'],
  );
});

test('validation: unknown dependency and duplicate id throw', () => {
  assert.throws(() => execute([tc('a', 'nope')], allPass), /unknown dependency/);
  assert.throws(() => execute([tc('a'), tc('a')], allPass), /duplicate test id/);
});

test('model: classification agrees with executor on a hand-built graph', () => {
  const cases = [
    tc('A', 'B'), tc('B', 'C'), tc('C', 'A'), tc('D', 'A'),
    tc('E'), tc('F', 'E'), tc('G'), tc('H', 'G'),
  ];
  const outcome = (id: string) => id !== 'G';
  const summary = execute(cases, outcome);
  const model = classify(cases, outcome);
  for (const r of summary.results) assert.equal(model.get(r.id), r.status, r.id);
  assert.deepEqual(new Set(summary.started), expectedStarted(cases, outcome));
});

// Seeded PRNG for reproducible random graphs.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(rand: () => number, n: number): TestCase[] {
  const cases: TestCase[] = [];
  for (let i = 0; i < n; i += 1) {
    const deps: string[] = [];
    for (let j = 0; j < n; j += 1) {
      // Allow backward edges so cycles (and multi-node SCCs) appear.
      if (i !== j && rand() < 0.12) deps.push(`n${String(j).padStart(3, '0')}`);
    }
    if (rand() < 0.02) deps.push(`n${String(i).padStart(3, '0')}`); // self-loop
    cases.push({ id: `n${String(i).padStart(3, '0')}`, deps });
  }
  return cases;
}

test('cross-check: executor started set matches full-graph model on random graphs', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = mulberry32(seed);
    const cases = randomGraph(rand, 14);
    const failing = new Set(
      cases.map((c) => c.id).filter(() => rand() < 0.25),
    );
    const outcome = (id: string) => !failing.has(id);
    const v = verifyAgainstModel(cases, outcome);
    assert.ok(v.startedMatch, `seed ${seed}: started sets differ`);
    assert.deepEqual(v.mismatches, [], `seed ${seed}: status mismatches`);
    assert.ok(v.ok);
  }
});
