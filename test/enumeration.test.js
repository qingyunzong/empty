import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { runRef } from '../test-helpers/ref-model.js';

// Four op templates; position-dependent parameters create insufficient funds,
// bad parents, time travel, full/partial reversals and duplicate-free ids.
const templates = [
  (i) => ({ type: 'deposit', clientOpId: `op${i}`, clock: i, amount: 100 }),
  (i) => ({ type: 'authorize', clientOpId: `op${i}`, clock: i, amount: 60, ttl: 3 }),
  (i) => ({
    type: 'capture', clientOpId: `op${i}`, clock: Math.max(0, i - 1), parentId: `op${Math.max(0, i - 1)}`, amount: 30,
  }),
  (i) => ({
    type: 'reverse', clientOpId: `op${i}`, clock: Math.max(0, i - 2), parentId: `op${Math.max(0, i - 1)}`, amount: 25,
  }),
];

function checkSequence(ops) {
  const engine = new Engine({ initialBalance: 50, hashChain: false });
  engine.load(ops);
  const ref = runRef(50, ops);
  assert.deepEqual(engine.view(), ref.view, `view mismatch for ${JSON.stringify(ops)}`);
  for (const op of ops) {
    assert.deepEqual(
      engine.results.get(op.clientOpId),
      ref.results.get(op.clientOpId),
      `result mismatch for ${op.clientOpId} in ${JSON.stringify(ops)}`,
    );
  }
}

test('exhaustive differential: all op sequences of length n <= 9 vs reference model', () => {
  const K = templates.length;
  const MAX = 9;
  let checked = 0;
  for (let n = 1; n <= MAX; n += 1) {
    const index = new Array(n).fill(0);
    for (;;) {
      checkSequence(index.map((t, i) => templates[t](i)));
      checked += 1;
      let pos = n - 1;
      while (pos >= 0) {
        index[pos] += 1;
        if (index[pos] < K) break;
        index[pos] = 0;
        pos -= 1;
      }
      if (pos < 0) break;
    }
  }
  assert.equal(checked, (4 ** 10 - 4) / 3); // sum_{n=1..9} 4^n = 349524
});

// Seeded fuzz with a wider alphabet (expire, short ttl, full reversals,
// reversal-of-reversal chains) at lengths up to 12.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fuzzTemplates = [
  ...templates,
  (i) => ({ type: 'expire', clientOpId: `op${i}`, clock: i + 2, parentId: `op${Math.max(0, i - 3)}` }),
  (i) => ({ type: 'authorize', clientOpId: `op${i}`, clock: Math.max(0, i - 1), amount: 40, ttl: 1 }),
  (i) => ({ type: 'reverse', clientOpId: `op${i}`, clock: i, parentId: `op${Math.max(0, i - 2)}` }),
  (i) => ({ type: 'reverse', clientOpId: `op${i}`, clock: i, parentId: `op${Math.max(0, i - 1)}` }),
];

test('seeded fuzz differential: 20000 random sequences, length <= 12', () => {
  const rand = mulberry32(20261004);
  for (let s = 0; s < 20000; s += 1) {
    const n = 1 + Math.floor(rand() * 12);
    const ops = [];
    for (let i = 0; i < n; i += 1) {
      ops.push(fuzzTemplates[Math.floor(rand() * fuzzTemplates.length)](i));
    }
    checkSequence(ops);
  }
});

test('replay consistency: any arrival order of the same op set yields the same tip hash', () => {
  const rand = mulberry32(7);
  for (let s = 0; s < 200; s += 1) {
    const n = 1 + Math.floor(rand() * 9);
    const ops = [];
    for (let i = 0; i < n; i += 1) {
      ops.push(fuzzTemplates[Math.floor(rand() * fuzzTemplates.length)](i));
    }
    const a = new Engine({ initialBalance: 50 });
    a.load(ops);
    const shuffled = [...ops];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const b = new Engine({ initialBalance: 50 });
    b.load(shuffled);
    assert.equal(b.tipHash, a.tipHash);
    assert.deepEqual(b.view(), a.view());
  }
});
