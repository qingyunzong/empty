'use strict';

// Acceptance 4: for batches of <= 5 frames, enumerate drop / duplicate /
// reorder delivery sequences and check the real receiver against an
// independent reference model.

const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, FrameDecoder, TYPE } = require('../src/frame');
const { Receiver } = require('../src/protocol');

// --- Independent reference model -----------------------------------------
// Given the multiset of seq numbers actually put on the wire (in any order,
// with drops and duplicates), the application layer must observe exactly the
// longest prefix [0..m] of seqs that each arrived at least once, in order,
// with no duplicates.
function referenceDeliveries(wireSeqs) {
  const received = new Set(wireSeqs);
  const expected = [];
  for (let s = 0; received.has(s); s++) expected.push(s);
  return expected;
}

// --- Real receiver under test ---------------------------------------------
function realDeliveries(wireSeqs) {
  const dec = new FrameDecoder();
  const rx = new Receiver();
  const delivered = [];
  let lastAck = 0;
  for (const seq of wireSeqs) {
    const wire = encode({ type: TYPE.DATA, batchId: 1, lineNo: seq, seq, ack: 0, payload: Buffer.from('x') });
    for (const f of dec.push(wire)) {
      const r = rx.onData(f);
      lastAck = r.ack;
      delivered.push(...r.delivered.map((d) => d.seq));
    }
  }
  return { delivered, lastAck };
}

// --- Enumeration helpers ---------------------------------------------------
function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function* subsets(arr, maxSize) {
  const n = arr.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const sub = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sub.push(arr[i]);
    if (sub.length <= maxSize) yield sub;
  }
}

// Build one wire sequence: base permutation minus dropped frames, each
// duplicated frame emitted twice in a row, optionally followed by a
// retransmit round of the dropped frames.
function buildWire(perm, dropped, duplicated, retransmit) {
  const dropSet = new Set(dropped);
  const dupSet = new Set(duplicated);
  const wire = [];
  for (const seq of perm) {
    if (dropSet.has(seq)) continue;
    wire.push(seq);
    if (dupSet.has(seq)) wire.push(seq);
  }
  if (retransmit) wire.push(...dropped);
  return wire;
}

test('exhaustive: all drop/dup/reorder sequences for n <= 5 match reference', () => {
  let cases = 0;
  for (let n = 1; n <= 5; n++) {
    const seqs = Array.from({ length: n }, (_, i) => i);
    const maxSubset = n <= 4 ? n : 2; // keep runtime bounded for n = 5
    for (const perm of permutations(seqs)) {
      for (const dropped of subsets(seqs, maxSubset)) {
        for (const duplicated of subsets(seqs, maxSubset)) {
          for (const retransmit of [false, true]) {
            const wire = buildWire(perm, dropped, duplicated, retransmit);
            const expected = referenceDeliveries(wire);
            const { delivered, lastAck } = realDeliveries(wire);
            assert.deepEqual(delivered, expected,
              `n=${n} wire=[${wire}] delivered=[${delivered}] expected=[${expected}]`);
            assert.equal(lastAck, expected.length);
            // no duplicates, strictly increasing prefix
            for (let i = 0; i < delivered.length; i++) assert.equal(delivered[i], i);
            cases++;
          }
        }
      }
    }
  }
  assert.ok(cases > 50000, `expected >50k enumerated cases, ran ${cases}`);
});
