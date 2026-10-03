'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InputError,
  ConservationError,
  validateEvent,
  EventCache,
  run,
  parseJsonl,
} = require('../lib');

function makeEvent(seq, overrides = {}) {
  return validateEvent({
    lot: 'L1',
    mold: 'M1',
    station: 'S1',
    seq,
    ts: seq * 100,
    kind: 'produce',
    qty: 10,
    hash: `h${seq}`,
    ...overrides,
  });
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('acceptance 1: out-of-order + duplicates matches sorted reference', () => {
  const rand = mulberry32(42);
  const base = Array.from({ length: 50 }, (_, i) => makeEvent(i + 1));
  const arriving = [];
  for (const e of shuffle(base, rand)) {
    arriving.push(e);
    if (rand() < 0.4) arriving.push(e); // duplicate delivery
  }
  const result = run(arriving, { now: 100000 });
  const reference = [...base].sort((a, b) => a.seq - b.seq);
  assert.equal(result.chain.length, reference.length);
  assert.deepEqual(
    result.chain.map((e) => e.seq),
    reference.map((e) => e.seq),
  );
  assert.deepEqual(
    result.chain.map((e) => e.hash),
    reference.map((e) => e.hash),
  );
  assert.equal(result.stats.duplicates, arriving.length - base.length);
});

test('acceptance 2: late correction revokes old cert and changes cert hash', () => {
  const events = [
    makeEvent(1, { qty: 100 }),
    makeEvent(2, { kind: 'split', qty: 60, parents: [1] }),
    makeEvent(3, { kind: 'split', qty: 40, parents: [1] }),
    // late correction: seq 2 was actually 55, so seq 3 must carry 45
    makeEvent(4, { kind: 'correct', target: 2, qty: 55, ts: 5000, hash: 'h2fix' }),
    makeEvent(5, { kind: 'correct', target: 3, qty: 45, ts: 5001, hash: 'h3fix' }),
  ];
  const result = run(events, { now: 6000 });
  const certs = result.certificates;
  assert.equal(certs.length, 3); // initial + 2 corrections
  assert.equal(certs[0].status, 'revoked');
  assert.equal(certs[1].status, 'revoked');
  assert.equal(certs[2].status, 'active');
  assert.notEqual(certs[0].certHash, certs[2].certHash);
  assert.notEqual(certs[1].certHash, certs[2].certHash);
  const seq2 = result.chain.find((e) => e.seq === 2);
  const seq3 = result.chain.find((e) => e.seq === 3);
  assert.equal(seq2.qty, 55);
  assert.equal(seq2.hash, 'h2fix');
  assert.equal(seq3.qty, 45);
  assert.deepEqual(result.corrections.map((c) => c.applied), [true, true]);
});

test('correction on future=true event is rejected, cert untouched', () => {
  const events = [
    makeEvent(1, { future: true }),
    makeEvent(2, { kind: 'correct', target: 1, qty: 99, ts: 5000, hash: 'hX' }),
  ];
  const result = run(events, { now: 6000 });
  assert.equal(result.corrections[0].applied, false);
  assert.equal(result.corrections[0].reason, 'target is future=true');
  assert.equal(result.certificates.length, 1);
  assert.equal(result.certificates[0].status, 'active');
  assert.equal(result.chain[0].qty, 10);
});

test('acceptance 3: deadline boundary event times out exactly at now - refTs == deadline', () => {
  // seq 2 missing between seq 1 (ts=100) and seq 3 (ts=150); deadline 1000
  const events = [
    makeEvent(1, { ts: 100 }),
    makeEvent(3, { ts: 150 }),
  ];
  const justBefore = run(events, { now: 1099, deadline: 1000 });
  assert.equal(justBefore.gaps.length, 0);
  assert.equal(justBefore.naks.length, 1);
  assert.equal(justBefore.naks[0].seq, 2);

  const exactlyAt = run(events, { now: 1100, deadline: 1000 });
  assert.equal(exactlyAt.naks.length, 0);
  assert.equal(exactlyAt.gaps.length, 1);
  assert.equal(exactlyAt.gaps[0].seq, 2);
  assert.equal(exactlyAt.gaps[0].waited, 1000);

  // gap must not block later available batches: seq 3 still in chain
  assert.deepEqual(exactlyAt.chain.map((e) => e.seq), [1, 3]);
});

test('acceptance 4: all 40320 permutations of seq 1..8 dedupe to the same chain', () => {
  const base = Array.from({ length: 8 }, (_, i) => makeEvent(i + 1));
  const chainOf = (arriving) => {
    const cache = new EventCache({ now: 0 });
    for (const e of arriving) cache.ingest(e);
    const chains = cache.buildChains();
    return JSON.stringify([...chains.values()].flat().map((e) => [e.seq, e.hash]));
  };
  const reference = chainOf(base);

  // Heap's algorithm over permutations of indices 0..7
  const idx = [0, 1, 2, 3, 4, 5, 6, 7];
  let count = 0;
  const check = () => {
    const arriving = idx.map((i) => base[i]);
    arriving.push(base[3]); // inject a duplicate for good measure
    arriving.unshift(base[5]);
    assert.equal(chainOf(arriving), reference);
    count += 1;
  };
  const generate = (k) => {
    if (k === 1) { check(); return; }
    for (let i = 0; i < k; i += 1) {
      generate(k - 1);
      const j = k % 2 === 0 ? i : 0;
      [idx[j], idx[k - 1]] = [idx[k - 1], idx[j]];
    }
  };
  generate(8);
  assert.equal(count, 40320);
});

test('duplicate with same hash dedupes; conflicting hash keeps first', () => {
  const cache = new EventCache({ now: 0 });
  assert.equal(cache.ingest(makeEvent(1)), 'added');
  assert.equal(cache.ingest(makeEvent(1)), 'duplicate');
  assert.equal(cache.ingest(makeEvent(1, { hash: 'other' })), 'conflict');
  assert.equal(cache.stats.added, 1);
  assert.equal(cache.stats.duplicates, 1);
  assert.equal(cache.stats.conflicts, 1);
});

test('conservation: split children must sum to parent qty', () => {
  const ok = run([
    makeEvent(1, { qty: 100 }),
    makeEvent(2, { kind: 'split', qty: 70, parents: [1] }),
    makeEvent(3, { kind: 'split', qty: 30, parents: [1] }),
  ]);
  assert.equal(ok.chain.length, 3);
  assert.throws(
    () => run([
      makeEvent(1, { qty: 100 }),
      makeEvent(2, { kind: 'split', qty: 70, parents: [1] }),
      makeEvent(3, { kind: 'split', qty: 31, parents: [1] }),
    ]),
    ConservationError,
  );
});

test('conservation: merge qty must equal sum of parents', () => {
  const ok = run([
    makeEvent(1, { qty: 40 }),
    makeEvent(2, { qty: 60 }),
    makeEvent(3, { kind: 'merge', qty: 100, parents: [1, 2] }),
  ]);
  assert.equal(ok.chain.length, 3);
  assert.throws(
    () => run([
      makeEvent(1, { qty: 40 }),
      makeEvent(2, { qty: 60 }),
      makeEvent(3, { kind: 'merge', qty: 99, parents: [1, 2] }),
    ]),
    ConservationError,
  );
});

test('validation rejects malformed events with InputError', () => {
  assert.throws(() => validateEvent(null), InputError);
  assert.throws(() => validateEvent(makeEvent(1, { seq: 0 })), InputError);
  assert.throws(() => validateEvent({ ...makeEvent(1), kind: 'bogus' }), InputError);
  assert.throws(() => validateEvent({ lot: 'L', mold: 'M', station: 'S', seq: 2, ts: 1, kind: 'split', qty: 1, hash: 'h', parents: [5] }), InputError);
  assert.throws(() => parseJsonl('{not json}\n'), InputError);
  assert.throws(() => parseJsonl('{"lot":"L"}\n'), InputError);
});

test('parseJsonl skips blank lines and parses valid events', () => {
  const events = parseJsonl('\n{"lot":"L","mold":"M","station":"S","seq":1,"ts":0,"kind":"produce","qty":5,"hash":"h"}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
});
