import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  bindSource,
  runDifferential,
  DiffTarget,
  DiffInput,
} from '../src/diff';
import { PlanScheduler, flushMicrotasks, mulberry32 } from '../src/scheduler';
import { Op, canonical } from '../src/sut';
import { ReferenceQueue } from '../src/impl/referenceQueue';
import { AltQueue } from '../src/impl/altQueue';
import { BuggyCancelQueue } from '../src/impl/buggyCancelQueue';

const SRC = __dirname + '/../../src';

const REF: DiffTarget = {
  binding: bindSource('reference', `${SRC}/impl/referenceQueue.ts`),
  make: (s) => new ReferenceQueue(s),
};
const ALT: DiffTarget = {
  binding: bindSource('alt', `${SRC}/impl/altQueue.ts`),
  make: (s) => new AltQueue(s),
};
const BUGGY: DiffTarget = {
  binding: bindSource('buggy-cancel', `${SRC}/impl/buggyCancelQueue.ts`),
  make: (s) => new BuggyCancelQueue(s),
};

function genOps(seed: number, count: number): Op[] {
  const rand = mulberry32(seed);
  const ops: Op[] = [];
  let submitted = 0;
  for (let i = 0; i < count; i++) {
    const r = rand();
    if (r < 0.4 || submitted === 0) {
      submitted += 1;
      ops.push({ kind: 'submit', name: `task-${submitted}` });
    } else if (r < 0.7) {
      ops.push({ kind: 'cancel', id: `j${1 + Math.floor(rand() * submitted)}` });
    } else if (r < 0.85) {
      ops.push({ kind: 'status', id: `j${1 + Math.floor(rand() * submitted)}` });
    } else {
      ops.push({ kind: 'tick' });
    }
  }
  return ops;
}

function input(ops: Op[], seed: number, a: DiffTarget, b: DiffTarget): DiffInput {
  return { ops, plan: { seed, maxDelay: 3 }, a, b };
}

test('canonical serialization sorts object keys, preserves array order', () => {
  assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonical([2, 1]), '[2,1]');
});

test('plan controls promise settlement deterministically', async () => {
  const settleOrder = async (seed: number): Promise<string[]> => {
    const scheduler = new PlanScheduler({ seed, maxDelay: 4 });
    const order: string[] = [];
    for (const tag of ['a', 'b', 'c', 'd', 'e']) {
      void scheduler.schedule(tag).then((v) => {
        order.push(v);
      });
    }
    for (let t = 0; t < 10; t++) {
      scheduler.advance();
      await flushMicrotasks();
    }
    assert.equal(scheduler.pending, 0);
    return order;
  };
  assert.deepEqual(await settleOrder(42), await settleOrder(42));
  assert.equal((await settleOrder(7)).length, 5);
});

test('equivalent implementations agree across many seeds', async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const report = await runDifferential(input(genOps(seed, 40), seed, REF, ALT));
    assert.equal(report.divergence, null, `seed ${seed}: ${JSON.stringify(report.divergence)}`);
    assert.equal(report.ok, true);
    assert.equal(report.minimalPrefix, null);
    assert.equal(report.opsExecuted, 40);
  }
});

test('acceptance: deliberately wrong cancellation is flagged', async () => {
  const ops: Op[] = [
    { kind: 'submit', name: 'x' },
    { kind: 'cancel', id: 'j1' },
    { kind: 'tick' },
    { kind: 'tick' },
    { kind: 'tick' },
  ];
  const report = await runDifferential(input(ops, 1, REF, BUGGY));
  assert.equal(report.ok, false);
  assert.ok(report.divergence);
  // The buggy queue emits `resolve:j1` after `cancel:j1` on a tick.
  assert.equal(report.divergence!.kind, 'events');
  assert.equal(report.divergence!.b, '["resolve:j1"]');
  assert.equal(report.divergence!.a, '[]');
  // Minimal prefix: everything up to and including the settling tick.
  assert.ok(report.minimalPrefix);
  assert.deepEqual(report.minimalPrefix, ops.slice(0, report.divergence!.opIndex + 1));
  assert.equal(report.minimalPrefix!.at(-1)!.kind, 'tick');
});

test('acceptance: buggy cancellation found across random sequences', async () => {
  let found = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const report = await runDifferential(input(genOps(seed, 60), seed, REF, BUGGY));
    if (!report.divergence) continue;
    found += 1;
    // Every reported divergence carries a reproducible minimal prefix.
    assert.ok(report.minimalPrefix, `seed ${seed}`);
    assert.equal(report.minimalPrefix!.length, report.divergence.opIndex + 1);
    const replay = await runDifferential(
      input(report.minimalPrefix!, seed, REF, BUGGY),
    );
    assert.equal(replay.ok, false, `seed ${seed}: prefix must reproduce`);
    assert.equal(replay.divergence!.kind, report.divergence.kind);
  }
  assert.ok(found > 0, 'expected the buggy implementation to be caught');
});

test('unfinished promises are not failures', async () => {
  // No ticks: nothing ever settles, nothing may be flagged.
  const ops: Op[] = [
    { kind: 'submit', name: 'a' },
    { kind: 'submit', name: 'b' },
    { kind: 'cancel', id: 'j1' },
  ];
  const clean = await runDifferential(input(ops, 5, REF, ALT));
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.pendingAtEnd, { a: 2, b: 2 });
  // Even the buggy implementation is innocent while its bug is unobservable.
  const unobserved = await runDifferential(input(ops, 5, REF, BUGGY));
  assert.equal(unobserved.ok, true);
  assert.deepEqual(unobserved.pendingAtEnd, { a: 2, b: 2 });
});

test('divergences are bound to source hashes', async () => {
  const ops: Op[] = [
    { kind: 'submit', name: 'x' },
    { kind: 'cancel', id: 'j1' },
    { kind: 'tick' },
    { kind: 'tick' },
    { kind: 'tick' },
  ];
  const report = await runDifferential(input(ops, 1, REF, BUGGY));
  const expectHash = (file: string) =>
    createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex');
  assert.equal(report.sources.a.sha256, expectHash(`${SRC}/impl/referenceQueue.ts`));
  assert.equal(report.sources.b.sha256, expectHash(`${SRC}/impl/buggyCancelQueue.ts`));
  assert.notEqual(report.sources.a.sha256, report.sources.b.sha256);
  assert.equal(REF.binding.sha256, expectHash(`${SRC}/impl/referenceQueue.ts`));
  assert.notEqual(ALT.binding.sha256, BUGGY.binding.sha256);
});

test('reports are byte-for-byte reproducible', async () => {
  const ops = genOps(9, 60);
  const first = await runDifferential(input(ops, 9, REF, BUGGY));
  const second = await runDifferential(input(ops, 9, REF, BUGGY));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
