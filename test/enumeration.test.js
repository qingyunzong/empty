// Acceptance 4: op sequences of length <= 12 are cross-checked against a reference
// state machine (from-scratch fold of the op log), with random crash injection
// at the three fixed fault points between ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from '../test-utils/helpers.js';
import { Store, SimulatedCrash } from '../src/store.js';
import { applyOp, INITIAL_STATE, DomainError, UndoClosedLoopError } from '../src/machine.js';
import { canonicalHash } from '../src/hash.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFECTS = ['D1', 'D2', 'D3', 'D4'];
const ORDERS = ['R1', 'R2'];
const FAULT_POINTS = [null, null, 'wal-append', 'snapshot-rename', 'index-update'];

function genOp(rng, log) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const kind = pick(['open', 'open', 'rework', 'inspect', 'inspect', 'correct', 'close', 'scrap', 'undo']);
  const did = () => pick(DEFECTS);
  const oid = () => pick(ORDERS);
  switch (kind) {
    case 'open': return ['open', { id: did(), desc: 'x' }];
    case 'rework': {
      const n = 1 + Math.floor(rng() * 3);
      const ids = new Set();
      while (ids.size < n) ids.add(did());
      return ['rework', { orderId: oid(), defectIds: [...ids] }];
    }
    case 'inspect': return ['inspect', { orderId: oid(), seq: Math.floor(rng() * 3), result: pick(['pass', 'fail']) }];
    case 'correct': return ['correct', { orderId: oid(), seq: Math.floor(rng() * 3), result: pick(['pass', 'fail']) }];
    case 'close': return ['close', { orderId: oid() }];
    case 'scrap': return ['scrap', { id: did() }];
    case 'undo': {
      if (log.length === 0) return ['open', { id: did(), desc: 'x' }];
      const target = pick(log);
      return ['undo', { undoOf: target.seq, target: { op: target.op, args: target.args } }];
    }
    default: throw new Error('unreachable');
  }
}

test('<=12 ops with crash injection match the reference state machine enumeration', () => {
  const TRIALS = 60;
  for (let trial = 0; trial < TRIALS; trial++) {
    const rng = mulberry32(trial + 1);
    const store = new Store(tmpDir(), { crashMode: 'throw' });
    const log = []; // successful WAL records == reference op log
    const length = 1 + Math.floor(rng() * 12); // 1..12 ops

    for (let i = 0; i < length; i++) {
      const [op, args] = genOp(rng, log);
      store.crashAt = FAULT_POINTS[Math.floor(rng() * FAULT_POINTS.length)];
      let rec;
      try {
        rec = store.apply(op, args);
      } catch (err) {
        if (err instanceof SimulatedCrash) {
          // The record was appended to the WAL before every fault point, so the
          // op is durable; the next recover() replays it. No retry, no duplicate.
          rec = store.lastAttemptedRec;
          store.crashAt = null;
        } else if (err instanceof DomainError || err instanceof UndoClosedLoopError) {
          continue; // rejected op: nothing persisted, reference skips it too
        } else {
          throw err;
        }
      }
      log.push(rec);
    }

    const { state } = store.recover();
    store.checkConsistency(state); // would throw HashMismatchError (exit 23 at CLI level)

    // Reference state machine: fold the op log from scratch, no persistence involved.
    const reference = structuredClone(INITIAL_STATE);
    for (const rec of log) applyOp(reference, rec);

    assert.equal(
      canonicalHash(state), canonicalHash(reference),
      `trial ${trial}: persisted+recovered state diverged from reference after ${log.length} ops`
    );
  }
});
