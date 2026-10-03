import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Prng } from '../src/prng.js';

test('same seed reproduces the same stream', () => {
  const a = new Prng(7);
  const b = new Prng(7);
  for (let i = 0; i < 32; i += 1) {
    assert.equal(a.nextU64(), b.nextU64());
  }
});

test('different seeds diverge', () => {
  const a = new Prng(7);
  const b = new Prng(8);
  assert.notEqual(a.nextU64(), b.nextU64());
});

test('draw index (seq) is recorded and resumable in O(1)', () => {
  const walked = new Prng(42);
  const draws = [];
  for (let i = 0; i < 10; i += 1) draws.push(walked.nextU64());
  assert.equal(walked.seq, 10);
  const resumed = Prng.fromState(42, 5);
  assert.equal(resumed.seq, 5);
  for (let i = 5; i < 10; i += 1) {
    assert.equal(resumed.nextU64(), draws[i]);
  }
  assert.equal(resumed.seq, 10);
});

test('int() stays in range and is deterministic', () => {
  const a = new Prng(99);
  const b = new Prng(99);
  for (let i = 0; i < 100; i += 1) {
    const v = a.int(61);
    assert.ok(v >= 0 && v < 61);
    assert.equal(v, b.int(61));
  }
});

test('no Math.random anywhere in the library or CLI', () => {
  const files = ['cli.js', ...readdirSync('src').map((f) => `src/${f}`)];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!source.includes('Math.random'), `${file} must not use Math.random`);
  }
});
