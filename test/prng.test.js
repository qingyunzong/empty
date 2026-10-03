import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Prng, mix32 } from '../src/prng.js';

test('same seed reproduces the same draw sequence', () => {
  const a = new Prng(7);
  const b = new Prng(7);
  const seqA = Array.from({ length: 16 }, () => a.nextU32());
  const seqB = Array.from({ length: 16 }, () => b.nextU32());
  assert.deepEqual(seqA, seqB);
});

test('different seeds produce different sequences', () => {
  const a = new Prng(1);
  const b = new Prng(2);
  const seqA = Array.from({ length: 8 }, () => a.nextU32());
  const seqB = Array.from({ length: 8 }, () => b.nextU32());
  assert.notDeepEqual(seqA, seqB);
});

test('sampling index is recorded and each draw is a pure function of (seed, index)', () => {
  const prng = new Prng(42);
  prng.nextU32();
  prng.nextU32();
  const third = prng.nextU32();
  assert.deepEqual(prng.snapshot(), { seed: 42, index: 3 });
  assert.equal(third, mix32(42, 2));
});

test('int and pick stay in range', () => {
  const prng = new Prng(99);
  for (let i = 0; i < 200; i += 1) {
    const v = prng.int(6);
    assert.ok(v >= 0 && v < 6);
    assert.ok(['a', 'b'].includes(prng.pick(['a', 'b'])));
  }
});

test('no source file uses Math.random', () => {
  for (const file of readdirSync(new URL('../src', import.meta.url))) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('Math.random'), `${file} must not use Math.random`);
  }
});
