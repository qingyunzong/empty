'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Monitor,
  stepMultiset,
  stepMultisetBrute,
  VIOLATION,
  SAFE,
  UNKNOWN,
} = require('../src/monitor');
const { buildDFA } = require('../src/regex');
const { MonitorError } = require('../src/errors');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('regex syntax: alternation, star, plus, option, groups, wildcard', () => {
  for (const p of ['a', 'a b c', 'a|b', '(a|b) c', 'a*', 'a+', 'a?', 'a (b|c)* d', '.', 'a . b', '(a b)+']) {
    const dfa = buildDFA(p);
    assert.ok(dfa.size >= 1, p);
  }
  assert.throws(() => buildDFA('(a b'), (e) => e instanceof MonitorError);
  assert.throws(() => buildDFA(''), (e) => e instanceof MonitorError);
});

test('three-valued semantics: UNKNOWN -> VIOLATION, and VIOLATION is sticky', () => {
  const m = new Monitor('arm fire');
  assert.equal(m.verdict(), UNKNOWN);
  m.applyBatch([{ id: 'e1', type: 'arm' }]);
  assert.equal(m.verdict(), UNKNOWN);
  m.applyBatch([{ id: 'e2', type: 'fire' }]);
  assert.equal(m.verdict(), VIOLATION);
  m.applyBatch([{ id: 'e3', type: 'reset' }]);
  m.applyBatch([{ id: 'e4', type: 'arm' }]);
  assert.equal(m.verdict(), VIOLATION); // irreversible
});

test('three-valued semantics: SAFE is reachable and stable', () => {
  const m = new Monitor('arm fire');
  m.applyBatch([{ id: 'e1', type: 'reset' }]); // kills any anchored match
  assert.equal(m.verdict(), SAFE);
  m.applyBatch([{ id: 'e2', type: 'arm' }, { id: 'e3', type: 'fire' }]);
  assert.equal(m.verdict(), SAFE); // no extension can ever violate
});

test('pattern matching the empty stream violates immediately', () => {
  const m = new Monitor('a*');
  assert.equal(m.verdict(), VIOLATION);
});

test('wildcard and unknown event types', () => {
  const m = new Monitor('a . b');
  m.applyBatch([{ id: 1, type: 'a' }]);
  m.applyBatch([{ id: 2, type: 'anything' }]);
  assert.equal(m.verdict(), UNKNOWN);
  m.applyBatch([{ id: 3, type: 'b' }]);
  assert.equal(m.verdict(), VIOLATION);
});

test('acceptance 1: intra-batch order changes conclusion -> ambiguous=true', () => {
  // tie-break order (a1=fire, a2=arm) is SAFE; the other order violates.
  const m = new Monitor('arm fire');
  const r = m.applyBatch([
    { id: 'a1', type: 'fire' },
    { id: 'a2', type: 'arm' },
  ]);
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.order, ['a1', 'a2']); // fixed tie-break by id
  assert.equal(m.verdict(), VIOLATION); // conservative: some order violates
  assert.equal(m.ambiguousEver, true);

  // Same multiset, order-independent pattern: no ambiguity.
  const m2 = new Monitor('x y');
  const r2 = m2.applyBatch([
    { id: 'b1', type: 'p' },
    { id: 'b2', type: 'q' },
  ]);
  assert.equal(r2.ambiguous, false);
  assert.equal(m2.verdict(), SAFE);
});

test('duplicate event id inside a macro-step is rejected', () => {
  const m = new Monitor('a b');
  assert.throws(
    () => m.applyBatch([{ id: 'x', type: 'a' }, { id: 'x', type: 'b' }]),
    (e) => e instanceof MonitorError && e.code === 'DUP_ID' && e.exitCode === 12,
  );
});

test('acceptance 4: macro-step DP matches brute-force permutation enumeration (n<=7)', () => {
  const rng = mulberry32(20261004);
  const patterns = ['a b', 'a (b|a) c', '(a|b)+ c', 'a b? c', 'a . c', '(a b|c a) b'];
  const types = ['a', 'b', 'c', 'z'];
  for (const pattern of patterns) {
    const dfa = buildDFA(pattern);
    for (let iter = 0; iter < 40; iter++) {
      const n = 1 + Math.floor(rng() * 7); // 1..7 events
      const batch = [];
      for (let i = 0; i < n; i++) batch.push(types[Math.floor(rng() * types.length)]);
      const startSet = new Set([dfa.start]);
      const exact = stepMultiset(dfa, startSet, batch);
      const brute = stepMultisetBrute(dfa, startSet, batch);
      assert.deepEqual([...exact].sort((x, y) => x - y), [...brute].sort((x, y) => x - y),
        `pattern=${pattern} batch=${batch.join(',')}`);
    }
  }
});

test('acceptance 4 (monitor level): applyBatch agrees with permutation enumeration', () => {
  const rng = mulberry32(7);
  const types = ['a', 'b', 'c'];
  for (let iter = 0; iter < 60; iter++) {
    const pattern = ['a b', 'a (a|b) b', '(a|b) (b|c)'][Math.floor(rng() * 3)];
    const m = new Monitor(pattern);
    const steps = 1 + Math.floor(rng() * 3);
    for (let s = 0; s < steps; s++) {
      const n = 1 + Math.floor(rng() * 7);
      const events = [];
      for (let i = 0; i < n; i++) {
        events.push({ id: `s${s}e${i}`, type: types[Math.floor(rng() * types.length)] });
      }
      const before = new Set(m.possible);
      const exact = stepMultiset(m.dfa, before, events.map((e) => e.type));
      const brute = stepMultisetBrute(m.dfa, before, events.map((e) => e.type));
      m.applyBatch(events);
      assert.deepEqual([...m.possible].sort((x, y) => x - y), [...exact].sort((x, y) => x - y));
      assert.deepEqual([...exact].sort((x, y) => x - y), [...brute].sort((x, y) => x - y));
    }
  }
});

test('acceptance 5: UNKNOWN is never reported as SAFE and no UNSAT certificate exists', () => {
  const rng = mulberry32(99);
  const types = ['a', 'b', 'c'];
  for (let iter = 0; iter < 200; iter++) {
    const pattern = ['a b', 'a (b|c)', '(a b|c)+', 'a . b'][Math.floor(rng() * 4)];
    const m = new Monitor(pattern);
    const batches = Math.floor(rng() * 4);
    for (let b = 0; b < batches; b++) {
      const n = 1 + Math.floor(rng() * 5);
      const events = [];
      for (let i = 0; i < n; i++) {
        events.push({ id: `${b}:${i}`, type: types[Math.floor(rng() * types.length)] });
      }
      m.applyBatch(events);
    }
    const verdict = m.verdict();
    const states = [...m.possible];
    const anyAccept = states.some((s) => m.dfa.accept.has(s));
    const allDead = states.every((s) => m.dfa.dead.has(s));
    if (anyAccept) assert.equal(verdict, VIOLATION);
    else if (allDead) assert.equal(verdict, SAFE);
    else assert.equal(verdict, UNKNOWN); // never SAFE, never "UNSAT"
    assert.ok([VIOLATION, SAFE, UNKNOWN].includes(verdict));
  }
});
