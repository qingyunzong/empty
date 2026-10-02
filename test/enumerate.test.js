'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEvents } = require('./helpers');
const { verifyEvents, rootOf } = require('../src/chain');
const { applyOps, computeUnchangedRanges, buildCert } = require('../src/patch');
const { checkLogs } = require('../src/check');

function expectedRanges(n, changedSet) {
  const ranges = [];
  let start = null;
  for (let s = 1; s <= n; s++) {
    if (!changedSet.has(s)) {
      if (start === null) start = s;
    } else if (start !== null) {
      ranges.push([start, s - 1]);
      start = null;
    }
  }
  if (start !== null) ranges.push([start, n]);
  return ranges;
}

test('enumerate all 2^10 fix sets for seq<=10: changedSeqs/unchangedRanges match and cert checks out', () => {
  const N = 10;
  const oldEvents = makeEvents(N);
  const oldRoot = verifyEvents(oldEvents);
  let count = 0;
  for (let mask = 0; mask < (1 << N); mask++) {
    const ops = [];
    const changedSet = new Set();
    for (let bit = 0; bit < N; bit++) {
      if (mask & (1 << bit)) {
        const seq = bit + 1;
        changedSet.add(seq);
        if (bit % 2 === 0) {
          ops.push({ op: 'replaceBody', seq, fields: { patched: mask } });
        } else {
          ops.push({ op: 'void', seq, reason: `mask-${mask}` });
        }
      }
    }
    const result = applyOps(oldEvents, ops);
    const cert = buildCert(oldEvents, oldRoot, result);

    assert.deepEqual(cert.changedSeqs, [...changedSet].sort((a, b) => a - b), `mask=${mask}`);
    assert.deepEqual(cert.unchangedRanges, expectedRanges(N, changedSet), `mask=${mask}`);
    assert.deepEqual(
      cert.unchangedRanges,
      computeUnchangedRanges(1, N, cert.changedSeqs),
      `mask=${mask}`
    );
    // new chain is valid and cert is consistent with old/new logs
    const newRoot = verifyEvents(result.newEvents);
    assert.equal(cert.newRoot, newRoot);
    assert.equal(cert.oldRoot, rootOf(oldEvents));
    const summary = checkLogs(oldEvents, result.newEvents, cert);
    assert.deepEqual(summary.changedSeqs, cert.changedSeqs);
    // every changed seq has a before/after record matching actual hashes
    for (const change of cert.changes) {
      assert.equal(change.before, oldEvents[change.seq - 1].hash);
      assert.equal(change.after, result.newEvents[change.seq - 1].hash);
    }
    count++;
  }
  assert.equal(count, 1024);
});
