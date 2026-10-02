import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLog } from './helpers.js';
import { applyFix, complementRanges } from '../src/patch.js';
import { checkEvents } from '../src/check.js';
import { verifyEvents } from '../src/log.js';

// Exhaustive: for a 10-event log, enumerate all 2^10 replaceBody fix sets and
// confirm the certified unchangedRanges exactly equal the complement, the new
// chain verifies, and checkEvents accepts every pair.
test('seq<=10 enumeration: every fix subset matches unchangedRanges', () => {
  const N = 10;
  const base = makeLog(N);
  for (let mask = 0; mask < (1 << N); mask++) {
    const patchOps = [];
    const expectedChanged = [];
    for (let s = 1; s <= N; s++) {
      if (mask & (1 << (s - 1))) {
        patchOps.push({ op: 'replaceBody', seq: s, fields: { reviewed: true, round: mask } });
        expectedChanged.push(s);
      }
    }
    const { newEvents, cert } = applyFix(base, { patchOps });

    assert.deepEqual(cert.changedSeqs, expectedChanged, `mask ${mask}`);
    assert.deepEqual(cert.unchangedRanges, complementRanges(expectedChanged, N), `mask ${mask}`);

    const covered = cert.unchangedRanges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
    assert.deepEqual(covered, Array.from({ length: N }, (_, i) => i + 1).filter((s) => !expectedChanged.includes(s)));

    verifyEvents(newEvents);
    const result = checkEvents(base, newEvents, cert);
    assert.deepEqual(result.changedSeqs, expectedChanged);

    for (const [a, b] of cert.unchangedRanges) {
      for (let s = a; s <= b; s++) {
        assert.deepEqual(newEvents[s - 1].body, base[s - 1].body, `mask ${mask} seq ${s}`);
      }
    }
    for (const s of expectedChanged) {
      assert.equal(newEvents[s - 1].body.reviewed, true);
    }
  }
});

test('enumeration spot-check: mixed void/replaceBody subsets', () => {
  const N = 10;
  const base = makeLog(N);
  for (let mask = 0; mask < (1 << N); mask += 7) {
    const patchOps = [];
    const expectedChanged = [];
    for (let s = 1; s <= N; s++) {
      if (mask & (1 << (s - 1))) {
        patchOps.push(s % 2 === 0
          ? { op: 'void', seq: s, reason: `void-${s}` }
          : { op: 'replaceBody', seq: s, fields: { flag: s } });
        expectedChanged.push(s);
      }
    }
    const { newEvents, cert } = applyFix(base, { patchOps });
    assert.deepEqual(cert.unchangedRanges, complementRanges(expectedChanged, N));
    verifyEvents(newEvents);
    checkEvents(base, newEvents, cert);
    for (const op of patchOps) {
      if (op.op === 'void') assert.deepEqual(newEvents[op.seq - 1].body, { voided: true, reason: op.reason });
    }
  }
});
