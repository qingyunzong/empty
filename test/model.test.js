import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PaymentService, OPENING_BALANCE } from '../src/payments.js';

// ---------------------------------------------------------------------------
// Independent oracle: a naive in-memory model of the spec, keeping its own
// mapping tables (requestId -> first result, txnId -> transaction). The real
// system (WAL + MVCC + crash recovery) is cross-checked against these tables
// after every single request, through a fresh reopen (full WAL replay).
// ---------------------------------------------------------------------------
class Model {
  constructor() {
    this.balance = OPENING_BALANCE;
    this.requests = new Map(); // requestId -> first committed result
    this.txns = new Map(); // txnId -> transaction record
    this.specs = new Map(); // requestId -> durable request spec (survives crashes)
    this.seq = 0; // BEGINs ever issued, committed or aborted
  }

  #txnId() {
    return 'T' + String(this.seq).padStart(6, '0');
  }

  pay({ requestId, amount }, crashAt) {
    if (this.requests.has(requestId)) return this.requests.get(requestId);
    if (amount > this.balance) throw Object.assign(new Error('insufficient'), { code: 'E_INSUFFICIENT' });
    this.specs.set(requestId, { op: 'pay', args: { amount } });
    this.seq += 1;
    const txnId = this.#txnId();
    if (crashAt === 'P1') throw Object.assign(new Error('crash'), { code: 'E_CRASH' });
    this.balance -= amount;
    this.txns.set(txnId, { txnId, type: 'pay', requestId, account: 'main', amount, status: 'PAID' });
    const result = { status: 'ok', type: 'pay', requestId, txnId, account: 'main', amount };
    this.requests.set(requestId, result);
    if (crashAt === 'P2') throw Object.assign(new Error('crash'), { code: 'E_CRASH' });
    return result;
  }

  cancel({ requestId, txnId }, crashAt) {
    if (this.requests.has(requestId)) return this.requests.get(requestId);
    const target = this.txns.get(txnId);
    if (!target) throw Object.assign(new Error('not found'), { code: 'E_NOT_FOUND' });
    if (target.status !== 'PAID') throw Object.assign(new Error('bad state'), { code: 'E_INVALID_STATE' });
    this.specs.set(requestId, { op: 'cancel', args: { txnId } });
    this.seq += 1;
    const cancelTxnId = this.#txnId();
    if (crashAt === 'P1') throw Object.assign(new Error('crash'), { code: 'E_CRASH' });
    this.balance += target.amount;
    this.txns.set(txnId, { ...target, status: 'CANCELLED' });
    this.txns.set(cancelTxnId, {
      txnId: cancelTxnId,
      type: 'cancel',
      requestId,
      account: 'main',
      amount: target.amount,
      status: 'APPLIED',
      targetTxnId: txnId,
    });
    const result = {
      status: 'ok',
      type: 'cancel',
      requestId,
      txnId: cancelTxnId,
      targetTxnId: txnId,
      account: 'main',
      amount: target.amount,
    };
    this.requests.set(requestId, result);
    if (crashAt === 'P2') throw Object.assign(new Error('crash'), { code: 'E_CRASH' });
    return result;
  }

  retry({ requestId }, crashAt) {
    if (this.requests.has(requestId)) return this.requests.get(requestId);
    const spec = this.specs.get(requestId);
    if (!spec) throw Object.assign(new Error('not found'), { code: 'E_NOT_FOUND' });
    return this[spec.op]({ requestId, ...spec.args }, crashAt);
  }
}

function runOp(svc, op, crashAt) {
  if (op.kind === 'pay') return svc.pay({ requestId: op.requestId, amount: op.amount }, { crashAt });
  if (op.kind === 'cancel') return svc.cancel({ requestId: op.requestId, txnId: op.txnId }, { crashAt });
  return svc.retry({ requestId: op.requestId }, { crashAt });
}

function runModelOp(model, op, crashAt) {
  if (op.kind === 'pay') return model.pay({ requestId: op.requestId, amount: op.amount }, crashAt);
  if (op.kind === 'cancel') return model.cancel({ requestId: op.requestId, txnId: op.txnId }, crashAt);
  return model.retry({ requestId: op.requestId }, crashAt);
}

function outcome(fn) {
  try {
    return { ok: true, result: fn() };
  } catch (err) {
    return { ok: false, code: err.code };
  }
}

// Execute one request sequence against both systems, reopening the real
// store (full WAL replay + recovery) after every request, and cross-check
// the independent mapping tables after every step.
function checkSequence(ops, crashes, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paydb-model-'));
  const model = new Model();
  try {
    for (let step = 0; step < ops.length; step += 1) {
      const crashAt = crashes(step);
      const svc = PaymentService.open(dir);
      const actual = outcome(() => runOp(svc, ops[step], crashAt));
      svc.close();
      const expected = outcome(() => runModelOp(model, ops[step], crashAt));

      const ctx = `${label} step ${step} (${JSON.stringify(ops[step])} crashAt=${crashAt})`;
      assert.equal(actual.ok, expected.ok, `ok mismatch: ${ctx}`);
      if (actual.ok) {
        assert.deepEqual(actual.result, expected.result, `result mismatch: ${ctx}`);
      } else {
        assert.equal(actual.code, expected.code, `error code mismatch: ${ctx}`);
      }

      // Cross-check the independent mapping tables via a fresh reopen.
      const verify = PaymentService.open(dir);
      assert.equal(verify.getBalance(), model.balance, `balance mismatch: ${ctx}`);
      assert.deepEqual(
        verify.listTransactions(),
        [...model.txns.values()].sort((a, b) => a.txnId.localeCompare(b.txnId)),
        `txn table mismatch: ${ctx}`,
      );
      assert.deepEqual(verify.listRequests(), Object.fromEntries(model.requests), `request table mismatch: ${ctx}`);
      verify.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Exhaustive enumeration of all length-4 request sequences over a 6-request
// alphabet, with deterministic P1/P2 crash injection varying per sequence/step.
test('exhaustive length-4 request sequences match the independent model', () => {
  const alphabet = [
    { kind: 'pay', requestId: 'r1', amount: 100 },
    { kind: 'pay', requestId: 'r2', amount: 250 },
    { kind: 'cancel', requestId: 'c1', txnId: 'T000001' },
    { kind: 'cancel', requestId: 'c2', txnId: 'T000001' }, // same target, other requestId
    { kind: 'cancel', requestId: 'c3', txnId: 'T000099' }, // unknown transaction
    { kind: 'retry', requestId: 'r1' },
  ];
  const n = alphabet.length;
  for (let seq = 0; seq < n ** 4; seq += 1) {
    const digits = [0, 0, 0, 0].map((_, i) => Math.floor(seq / n ** i) % n);
    const ops = digits.map((d) => alphabet[d]);
    const crashes = (step) => {
      if ((seq + step) % 6 === 3) return 'P1';
      if ((seq * 3 + step) % 7 === 2) return 'P2';
      return undefined;
    };
    checkSequence(ops, crashes, `seq#${seq}`);
  }
});

// Seeded randomized enumeration of longer sequences with random crashes,
// including insufficient-funds and retry-of-cancel requests.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('seeded random length-12 sequences with random crashes match the model', () => {
  const rand = mulberry32(20261003);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let seq = 0; seq < 200; seq += 1) {
    const ops = [];
    for (let i = 0; i < 12; i += 1) {
      const kind = pick(['pay', 'pay', 'cancel', 'cancel', 'retry', 'retry']);
      if (kind === 'pay') {
        ops.push({
          kind,
          requestId: pick(['r1', 'r2', 'r3', 'r4', 'r5']),
          amount: pick([50, 100, 250, 900, 1500]),
        });
      } else if (kind === 'cancel') {
        ops.push({
          kind,
          requestId: pick(['c1', 'c2', 'c3', 'c4', 'c5']),
          txnId: pick(['T000001', 'T000002', 'T000003', 'T000004', 'T000005', 'T000006', 'T000099']),
        });
      } else {
        ops.push({ kind, requestId: pick(['r1', 'r2', 'r3', 'r4', 'r5', 'c1', 'c2', 'c3', 'c4', 'c5']) });
      }
    }
    const crashes = () => {
      const roll = rand();
      if (roll < 0.15) return 'P1';
      if (roll < 0.3) return 'P2';
      return undefined;
    };
    checkSequence(ops, crashes, `random seq#${seq}`);
  }
});
