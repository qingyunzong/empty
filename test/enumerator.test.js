import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MarginCallEngine, SimulatedCrash, computeCertificate } from '../src/engine.js';

// Independent brute-force model of the expected behaviour. It deliberately
// re-derives the freeze/rollback sets from first principles so the engine is
// checked against a separate implementation.
function bruteForceExpected(accounts, targetAmount, cancelAfterAccount) {
  const sorted = [...accounts].sort(
    (x, y) => x.priority - y.priority || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  const freezes = [];
  let remaining = targetAmount;
  let processed = 0;
  let cancelled = false;
  while (processed < sorted.length && remaining > 0) {
    if (cancelAfterAccount !== null && processed >= cancelAfterAccount) {
      cancelled = true;
      break;
    }
    const account = sorted[processed];
    const amount = account.failFreeze ? 0 : Math.min(account.available, remaining);
    if (amount > 0) freezes.push({ accountId: account.id, amount });
    remaining -= amount;
    processed += 1;
  }
  let status;
  if (cancelled) status = 'CANCELLED';
  else if (remaining <= 0) status = 'CONFIRMED';
  else status = 'FAILED';
  const rollbacks = status === 'CONFIRMED' ? [] : [...freezes].reverse();
  return { status, freezes, rollbacks };
}

function runToCompletion(logDir, event) {
  const engine = new MarginCallEngine(logDir);
  for (;;) {
    try {
      return engine.run(event);
    } catch (err) {
      if (!(err instanceof SimulatedCrash)) throw err;
    }
  }
}

function toMap(list) {
  const map = {};
  for (const item of list) map[item.accountId] = (map[item.accountId] ?? 0) + item.amount;
  return map;
}

test('enumerator: balances x fault points x cancel points match brute force', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-enum-'));
  const balanceOptions = [0, 40, 80];
  const targetOptions = [50, 100];
  const failOptions = [-1, 0]; // no failing account, or first account fails
  const crashOptions = [null, 1, 2, 3];
  const cancelOptions = [null, 0, 1, 2, 3];
  const priorities = { a: 2, b: 1, c: 3 }; // priority order: b, a, c

  let cases = 0;
  for (const ba of balanceOptions)
    for (const bb of balanceOptions)
      for (const bc of balanceOptions)
        for (const target of targetOptions)
          for (const failIdx of failOptions)
            for (const crash of crashOptions)
              for (const cancel of cancelOptions) {
                const balances = { a: ba, b: bb, c: bc };
                const accounts = Object.keys(priorities).map((id, idx) => ({
                  id,
                  priority: priorities[id],
                  available: balances[id],
                  failFreeze: idx === failIdx,
                }));
                const expected = bruteForceExpected(accounts, target, cancel);

                const dir = path.join(root, `case-${cases}`);
                const result = runToCompletion(dir, {
                  callId: 'enum-call',
                  targetAmount: target,
                  accounts,
                  crashAfterAccount: crash,
                  cancelAfterAccount: cancel,
                });

                const label = JSON.stringify({ balances, target, failIdx, crash, cancel });
                assert.equal(result.status, expected.status, `status ${label}`);
                assert.deepEqual(
                  toMap(result.freezes),
                  toMap(expected.freezes),
                  `freezes ${label}`,
                );
                assert.deepEqual(
                  toMap(result.rollbacks),
                  toMap(expected.rollbacks),
                  `rollbacks ${label}`,
                );

                if (expected.status === 'CONFIRMED') {
                  assert.equal(result.totalFrozen, target, `total ${label}`);
                  assert.equal(
                    result.certificate,
                    computeCertificate({
                      callId: 'enum-call',
                      targetAmount: target,
                      freezes: expected.freezes,
                    }),
                    `certificate ${label}`,
                  );
                  assert.equal(result.rollbacks.length, 0, `no rollback ${label}`);
                } else {
                  // No orphan freezes: everything frozen was rolled back.
                  assert.deepEqual(
                    toMap(result.rollbacks),
                    toMap(result.freezes),
                    `orphan check ${label}`,
                  );
                  assert.equal(result.totalFrozen, 0, `net zero ${label}`);
                  assert.equal(result.certificate, null, `no certificate ${label}`);
                }
                cases += 1;
              }
  assert.equal(cases, 27 * 2 * 2 * 4 * 5);
});
