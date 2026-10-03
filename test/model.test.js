'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger, CrashError } = require('../ledger');

const LIMIT = 100;

// Independent sequential reference model: plain in-memory application of the
// accepted prefix of operations, sharing no code with the Ledger.
function referenceModel(ops) {
  const accounts = new Map();
  const seen = new Set();
  let seq = 0;
  for (const op of ops) {
    if (seen.has(op.eventId)) continue;
    const existing = accounts.get(op.account);
    const acc = existing || { limit: LIMIT, held: 0, committed: 0, frozen: false };
    switch (op.type) {
      case 'reserve':
        if (acc.frozen) continue;
        if (acc.limit - acc.held - acc.committed < op.amount) continue;
        acc.held += op.amount;
        break;
      case 'commit':
        if (acc.held < op.amount) continue;
        acc.held -= op.amount;
        acc.committed += op.amount;
        break;
      case 'release':
        if (acc.held < op.amount) continue;
        acc.held -= op.amount;
        break;
      case 'freeze':
        acc.frozen = true;
        break;
      default:
        throw new Error(`bad op ${op.type}`);
    }
    if (!existing) accounts.set(op.account, acc);
    seen.add(op.eventId);
    seq += 1;
  }
  const out = {};
  for (const [name, acc] of [...accounts.entries()].sort()) {
    out[name] = {
      limit: acc.limit,
      held: acc.held,
      committed: acc.committed,
      available: acc.limit - acc.held - acc.committed,
      frozen: acc.frozen,
    };
  }
  return { seq, accounts: out };
}

function assertMatchesModel(ledger, ops, label) {
  const expected = referenceModel(ops);
  const snap = ledger.snapshot();
  assert.equal(snap.seq, expected.seq, `${label}: seq`);
  assert.deepEqual(snap.accounts, expected.accounts, `${label}: accounts`);
  assert.equal(ledger.recovery.truncated, false, `${label}: unexpected truncation`);
}

const ALPHABET = [
  { type: 'reserve', account: 'a', amount: 30 },
  { type: 'reserve', account: 'a', amount: 60 },
  { type: 'commit', account: 'a', amount: 20 },
  { type: 'release', account: 'a', amount: 10 },
  { type: 'freeze', account: 'a', amount: 0 },
];

function* sequences(maxLen) {
  const current = [];
  function* walk(depth) {
    if (depth === maxLen) return;
    for (const op of ALPHABET) {
      current.push(op);
      yield [...current];
      yield* walk(depth + 1);
      current.pop();
    }
  }
  yield* walk(0);
}

test('model: every op sequence up to 5 events, crashed at every fault point', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-model-'));
  let scenarios = 0;
  let fileNo = 0;

  for (const seq of sequences(5)) {
    fileNo += 1;
    const file = path.join(dir, `s${fileNo}.jsonl`);
    let ledger = new Ledger(file, { limit: LIMIT });
    const accepted = [];

    for (let k = 0; k < seq.length; k += 1) {
      const op = { ...seq[k], eventId: `f${fileNo}-e${k}` };
      const label = `seq=${seq.map((o) => o.type[0] + o.amount).join(',')} cut=${k}`;
      const bytesBefore = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);

      // Fault point: beforeAppend -> crash, event must not exist.
      let beforeResult = null;
      try {
        beforeResult = ledger.append(op, { crash: 'beforeAppend' });
      } catch (err) {
        assert.ok(err instanceof CrashError && err.point === 'beforeAppend', label);
      }
      const bytesAfter = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
      assert.deepEqual(bytesAfter, bytesBefore, `${label}: beforeAppend crash must not write`);
      assertMatchesModel(new Ledger(file, { limit: LIMIT }), accepted, `${label} beforeAppend`);
      scenarios += 1;

      if (beforeResult !== null) {
        // Event was rejected by business rules: no crash point is reached.
        assert.equal(beforeResult.applied, false, label);
        continue;
      }

      // Fault point: afterAppend -> crash, event must be persisted.
      assert.throws(
        () => ledger.append(op, { crash: 'afterAppend' }),
        (err) => err instanceof CrashError && err.point === 'afterAppend',
        label,
      );
      ledger = new Ledger(file, { limit: LIMIT });
      accepted.push(op);
      assertMatchesModel(ledger, accepted, `${label} afterAppend`);
      scenarios += 1;

      // Retry of the same eventId after recovery must be an idempotent no-op.
      const retry = ledger.append(op);
      assert.equal(retry.applied, false, `${label}: retry`);
      assert.equal(retry.reason, 'duplicate eventId', label);
      assertMatchesModel(new Ledger(file, { limit: LIMIT }), accepted, `${label} retry`);
      scenarios += 1;
    }

    assertMatchesModel(new Ledger(file, { limit: LIMIT }), accepted, `final ${fileNo}`);
  }

  t.diagnostic(`model scenarios checked: ${scenarios}`);
});
