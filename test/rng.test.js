import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DeterministicRng } from '../src/rng.js';

test('same seed produces identical uint32 stream', () => {
  const a = new DeterministicRng(42);
  const b = new DeterministicRng(42);
  const seqA = Array.from({ length: 100 }, () => a.nextUint32());
  const seqB = Array.from({ length: 100 }, () => b.nextUint32());
  assert.deepEqual(seqA, seqB);
});

test('different seeds diverge', () => {
  const a = new DeterministicRng(1);
  const b = new DeterministicRng(2);
  const seqA = Array.from({ length: 10 }, () => a.nextUint32());
  const seqB = Array.from({ length: 10 }, () => b.nextUint32());
  assert.notDeepEqual(seqA, seqB);
});

test('nextInt stays within bounds including edge bounds', () => {
  const rng = new DeterministicRng(7);
  assert.equal(rng.nextInt(1), 0);
  for (let i = 0; i < 500; i += 1) {
    const v = rng.nextInt(3);
    assert.ok(v >= 0 && v < 3);
  }
  const big = new DeterministicRng(99);
  for (let i = 0; i < 100; i += 1) {
    const v = big.nextInt(0xffffffff);
    assert.ok(v >= 0 && v < 0xffffffff);
  }
});

test('invalid seeds are rejected with INVALID_INPUT', () => {
  for (const bad of [-1, 1.5, Number.NaN, 0x100000000, '42']) {
    assert.throws(() => new DeterministicRng(bad), { code: 'INVALID_INPUT' });
  }
});

test('no Math.random or Date-based randomness in source', () => {
  for (const file of readdirSync(new URL('../src', import.meta.url))) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes('Math.random'), `${file} uses Math.random`);
    assert.ok(!/new Date|Date\.now/.test(source), `${file} uses Date`);
  }
  const cli = readFileSync(new URL('../cli.js', import.meta.url), 'utf8');
  assert.ok(!cli.includes('Math.random'));
  assert.ok(!/new Date|Date\.now/.test(cli));
});
