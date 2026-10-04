import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  createState,
  applySubmit,
  applyCancel,
  applySettle,
  pendingEntries,
  stateHash,
} from '../src/ledger.js';
import { Store, recoverFromDisk, CrashError } from '../src/store.js';
import { recordRecoveryHash } from '../src/recovery-report.js';

const PARTICIPANTS = ['alice', 'bob', 'carol'];
const CRASH_POINTS = [null, 'settle:beforeRename', 'settle:afterRename'];
const MAX_N = 6;

function makeEntry(i) {
  return {
    entryId: `e${i}`,
    payer: PARTICIPANTS[i % PARTICIPANTS.length],
    payee: PARTICIPANTS[(i + 1) % PARTICIPANTS.length],
    amount: (i + 1) * 10,
  };
}

function* combinations(items, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i < items.length; i += 1) {
    yield* combinations(items, k, i + 1, [...prefix, items[i]]);
  }
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) {
      yield [items[i], ...perm];
    }
  }
}

// All ordered cancel sequences over n entries: every permutation of every subset.
function* cancelSequences(n) {
  const ids = Array.from({ length: n }, (_, i) => i);
  yield [];
  for (let k = 1; k <= n; k += 1) {
    for (const subset of combinations(ids, k)) {
      yield* permutations(subset);
    }
  }
}

// Reference model: pure in-memory application of the same op sequence.
// A crash at settle:beforeRename means the settle never became durable.
function expectedState(n, cancelOrder, crashPoint) {
  const state = createState();
  for (let i = 0; i < n; i += 1) applySubmit(state, makeEntry(i));
  for (const idx of cancelOrder) applyCancel(state, { entryId: `e${idx}` });
  if (crashPoint !== 'settle:beforeRename' && pendingEntries(state).length > 0) {
    applySettle(state);
  }
  return state;
}

function runScenario(baseDir, n, cancelOrder, crashPoint) {
  const dir = fs.mkdtempSync(path.join(baseDir, 'scn-'));
  try {
    const store = new Store(dir, {
      onCrashPoint(point) {
        if (point === crashPoint) throw new CrashError(point);
      },
    });
    for (let i = 0; i < n; i += 1) store.submit(makeEntry(i));
    for (const idx of cancelOrder) store.cancel(`e${idx}`);
    let crashed = false;
    try {
      store.settle();
    } catch (err) {
      if (err instanceof CrashError) crashed = true;
      else throw err;
    }
    const recovered = recoverFromDisk(dir);
    return { recovered, crashed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(`exhaustive: n=1..${MAX_N} entries x all cancel orders x all crash points`, (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-enum-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));

  let total = 0;
  const finalHash = createHash('sha256');
  for (let n = 1; n <= MAX_N; n += 1) {
    for (const crashPoint of CRASH_POINTS) {
      const aggregate = createHash('sha256');
      let count = 0;
      for (const cancelOrder of cancelSequences(n)) {
        const { recovered, crashed } = runScenario(baseDir, n, cancelOrder, crashPoint);
        const expected = expectedState(n, cancelOrder, crashPoint);
        const expectedHash = stateHash(expected);

        assert.equal(
          recovered.recoveryHash,
          expectedHash,
          `mismatch n=${n} crash=${crashPoint} cancels=[${cancelOrder}] source=${recovered.source}`,
        );

        const settled = Object.values(recovered.state.entries).filter(
          (e) => e.status === 'settled',
        );
        const cancelledCount = cancelOrder.length;
        if (crashPoint === 'settle:beforeRename') {
          assert.equal(crashed, n - cancelledCount > 0);
          assert.equal(settled.length, 0, 'beforeRename must never settle');
        } else {
          assert.equal(
            settled.length,
            n - cancelledCount,
            `crash=${crashPoint} must settle every non-cancelled entry`,
          );
        }

        aggregate.update(recovered.recoveryHash).update('\n');
        if (n <= 2) {
          recordRecoveryHash(
            `n=${n} crash=${crashPoint ?? 'none'} cancels=[${cancelOrder}] source=${recovered.source}`,
            recovered.recoveryHash,
          );
        }
        count += 1;
        total += 1;
      }
      const aggregateHex = aggregate.digest('hex');
      finalHash.update(aggregateHex).update('\n');
      recordRecoveryHash(
        `AGG n=${n} crash=${crashPoint ?? 'none'} scenarios=${count}`,
        aggregateHex,
      );
    }
  }
  recordRecoveryHash(`ENUM verified total=${total} scenarios`, finalHash.digest('hex'));
});
