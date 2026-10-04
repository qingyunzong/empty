import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaymentService, CrashSimulated, DEFAULT_BALANCE } from '../src/payments.js';

function tmpdb() {
  return mkdtempSync(join(tmpdir(), 'paydb-'));
}

const dirs = [];
function db() {
  const dir = tmpdb();
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('acceptance 1: duplicate pay deducts once and returns the same transaction', () => {
  const dir = db();
  const svc = new PaymentService(dir);
  const first = svc.pay({ requestId: 'r1', account: 'alice', amount: 100 });
  assert.equal(first.ok, true);
  const dup = svc.pay({ requestId: 'r1', account: 'alice', amount: 100 });
  assert.deepEqual(dup, first);
  assert.equal(dup.txId, first.txId);
  assert.equal(svc.getBalance('alice').balance, DEFAULT_BALANCE - 100);

  // idempotency survives restart as well
  const restarted = new PaymentService(dir);
  const dup2 = restarted.pay({ requestId: 'r1', account: 'alice', amount: 100 });
  assert.deepEqual(dup2, first);
  assert.equal(restarted.getBalance('alice').balance, DEFAULT_BALANCE - 100);
});

test('acceptance 2a: crash at P1 (after change, before COMMIT) rolls back; retry creates a new transaction', () => {
  const dir = db();
  const crashing = new PaymentService(dir, { crashAt: 'P1' });
  assert.throws(
    () => crashing.pay({ requestId: 'p1', account: 'bob', amount: 40 }),
    (err) => err instanceof CrashSimulated && err.point === 'P1',
  );

  const svc = new PaymentService(dir);
  // rolled-back transaction never became visible
  assert.equal(svc.getTransaction('tx-1').error, 'E_NOT_FOUND');
  assert.equal(svc.getBalance('bob').balance, DEFAULT_BALANCE);

  const retried = svc.retry({ requestId: 'p1' });
  assert.equal(retried.ok, true);
  assert.equal(retried.txId, 'tx-2'); // a fresh transaction
  assert.equal(svc.getBalance('bob').balance, DEFAULT_BALANCE - 40);

  // further retries / duplicate pays replay the committed result, no double charge
  assert.deepEqual(svc.retry({ requestId: 'p1' }), retried);
  assert.deepEqual(new PaymentService(dir).pay({ requestId: 'p1', account: 'bob', amount: 40 }), retried);
  assert.equal(new PaymentService(dir).getBalance('bob').balance, DEFAULT_BALANCE - 40);
});

test('acceptance 2b: crash at P2 (after COMMIT, before response) keeps commit; retry returns original transaction', () => {
  const dir = db();
  const crashing = new PaymentService(dir, { crashAt: 'P2' });
  assert.throws(
    () => crashing.pay({ requestId: 'p2', account: 'carol', amount: 40 }),
    (err) => err instanceof CrashSimulated && err.point === 'P2',
  );

  const svc = new PaymentService(dir);
  const retried = svc.retry({ requestId: 'p2' });
  assert.equal(retried.ok, true);
  assert.equal(retried.txId, 'tx-1'); // the original committed transaction
  assert.equal(svc.getBalance('carol').balance, DEFAULT_BALANCE - 40); // charged exactly once

  assert.deepEqual(svc.retry({ requestId: 'p2' }), retried);
  assert.deepEqual(svc.pay({ requestId: 'p2', account: 'carol', amount: 40 }), retried);
  assert.equal(new PaymentService(dir).getBalance('carol').balance, DEFAULT_BALANCE - 40);
});

test('acceptance 3: repeated cancel replays first result; cancel of unknown tx is E_NOT_FOUND', () => {
  const dir = db();
  const svc = new PaymentService(dir);
  const paid = svc.pay({ requestId: 'pay-1', account: 'dan', amount: 70 });

  const cancelled = svc.cancel({ requestId: 'c1', txId: paid.txId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, 'canceled');
  assert.equal(svc.getBalance('dan').balance, DEFAULT_BALANCE);

  const again = svc.cancel({ requestId: 'c1', txId: paid.txId });
  assert.deepEqual(again, cancelled); // first cancel result, no second refund
  assert.equal(svc.getBalance('dan').balance, DEFAULT_BALANCE);

  const missing = svc.cancel({ requestId: 'c2', txId: 'tx-nope' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'E_NOT_FOUND');

  // a *new* requestId canceling an already-canceled payment is a state error
  const stale = svc.cancel({ requestId: 'c3', txId: paid.txId });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'E_STATE');
  assert.equal(svc.getBalance('dan').balance, DEFAULT_BALANCE);

  assert.equal(svc.getTransaction('tx-nope').error, 'E_NOT_FOUND');
});

test('cancel crash at P1 then retry cancels exactly once', () => {
  const dir = db();
  const svc = new PaymentService(dir);
  const paid = svc.pay({ requestId: 'pay-1', account: 'erin', amount: 55 });

  const crashing = new PaymentService(dir, { crashAt: 'P1' });
  assert.throws(() => crashing.cancel({ requestId: 'cx', txId: paid.txId }), CrashSimulated);

  const restarted = new PaymentService(dir);
  assert.equal(restarted.getTransaction(paid.txId).txn.status, 'paid'); // rollback
  const retried = restarted.retry({ requestId: 'cx' });
  assert.equal(retried.ok, true);
  assert.equal(restarted.getBalance('erin').balance, DEFAULT_BALANCE);
  assert.deepEqual(new PaymentService(dir).retry({ requestId: 'cx' }), retried);
});

test('wal tolerates a torn tail record', () => {
  const dir = db();
  const svc = new PaymentService(dir);
  svc.pay({ requestId: 'r1', account: 'amy', amount: 10 });
  svc.close();
  appendFileSync(join(dir, 'wal.log'), '{"type":"begin","txnId":"tx-2","req'); // torn write

  const restarted = new PaymentService(dir);
  assert.equal(restarted.getBalance('amy').balance, DEFAULT_BALANCE - 10);
  const paid = restarted.pay({ requestId: 'r2', account: 'amy', amount: 5 });
  assert.equal(paid.ok, true);
  assert.equal(restarted.getBalance('amy').balance, DEFAULT_BALANCE - 15);
});

// ---------------------------------------------------------------------------
// Sequence enumeration checked against an independent mapping-table model.
// The model is a deliberately naive in-memory reference implementation: plain
// Maps, atomic apply, no WAL. Both sides must agree on every response and on
// the final state for every enumerated request sequence.
// ---------------------------------------------------------------------------

class ModelCrash extends Error {}

class ModelSystem {
  constructor() {
    this.balances = new Map();
    this.txns = new Map();
    this.idem = new Map();
    this.intents = new Map();
    this.beginCount = 0;
  }

  #run(requestId, op, params, crashAt, build) {
    if (this.idem.has(requestId)) return this.idem.get(requestId);
    const txnId = `tx-${this.beginCount + 1}`;
    this.beginCount += 1;
    if (!this.intents.has(requestId)) this.intents.set(requestId, { op, params });
    const { result, apply } = build(txnId);
    if (crashAt === 'P1') throw new ModelCrash('P1');
    apply();
    this.idem.set(requestId, result);
    if (crashAt === 'P2') throw new ModelCrash('P2');
    return result;
  }

  pay({ requestId, account, amount }, crashAt = null) {
    return this.#run(requestId, 'pay', { account, amount }, crashAt, (txnId) => {
      if (!Number.isFinite(amount) || amount <= 0) {
        return { result: { ok: false, op: 'pay', requestId, error: 'E_INVALID_AMOUNT', amount }, apply: () => {} };
      }
      const balance = this.balances.get(account) ?? DEFAULT_BALANCE;
      const txn = { txId: txnId, requestId, kind: 'payment', account, amount, status: 'paid' };
      return {
        result: { ok: true, op: 'pay', requestId, txId: txnId, account, amount, balance: balance - amount, status: 'paid' },
        apply: () => {
          this.balances.set(account, balance - amount);
          this.txns.set(txnId, txn);
        },
      };
    });
  }

  cancel({ requestId, txId }, crashAt = null) {
    return this.#run(requestId, 'cancel', { txId }, crashAt, (txnId) => {
      const payment = this.txns.get(txId);
      if (!payment || payment.kind !== 'payment') {
        return { result: { ok: false, op: 'cancel', requestId, error: 'E_NOT_FOUND', txId }, apply: () => {} };
      }
      if (payment.status !== 'paid') {
        return {
          result: { ok: false, op: 'cancel', requestId, error: 'E_STATE', txId, status: payment.status },
          apply: () => {},
        };
      }
      const balance = this.balances.get(payment.account) ?? DEFAULT_BALANCE;
      const cancelTxn = {
        txId: txnId, requestId, kind: 'cancel', target: txId,
        account: payment.account, amount: payment.amount, status: 'canceled',
      };
      return {
        result: {
          ok: true, op: 'cancel', requestId, cancelTxId: txnId, txId,
          account: payment.account, refund: payment.amount,
          balance: balance + payment.amount, status: 'canceled',
        },
        apply: () => {
          this.balances.set(payment.account, balance + payment.amount);
          this.txns.set(txId, { ...payment, status: 'canceled', canceledBy: txnId });
          this.txns.set(txnId, cancelTxn);
        },
      };
    });
  }

  retry({ requestId }, crashAt = null) {
    if (this.idem.has(requestId)) return this.idem.get(requestId);
    const intent = this.intents.get(requestId);
    if (!intent) return { ok: false, op: 'retry', requestId, error: 'E_NOT_FOUND' };
    if (intent.op === 'pay') return this.pay({ requestId, ...intent.params }, crashAt);
    return this.cancel({ requestId, ...intent.params }, crashAt);
  }

  getTransaction(txId) {
    const txn = this.txns.get(txId);
    if (!txn) return { ok: false, op: 'get', error: 'E_NOT_FOUND', txId };
    return { ok: true, op: 'get', txn };
  }

  getResultByRequestId(requestId) {
    if (!this.idem.has(requestId)) return { ok: false, op: 'get', error: 'E_NOT_FOUND', requestId };
    return this.idem.get(requestId);
  }

  dumpState() {
    const sort = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    return { balances: sort(this.balances), transactions: sort(this.txns), idem: sort(this.idem) };
  }
}

const CRASH = { crash: true };

// Operation pool for enumeration. txRef resolves through each side's own
// idempotency table, so the two implementations stay independent.
const OP_POOL = [
  { kind: 'pay', requestId: 'p1', account: 'A', amount: 50 },
  { kind: 'pay', requestId: 'p1', account: 'A', amount: 50, crashAt: 'P1' },
  { kind: 'pay', requestId: 'p1', account: 'A', amount: 50, crashAt: 'P2' },
  { kind: 'pay', requestId: 'p2', account: 'A', amount: 30 },
  { kind: 'pay', requestId: 'p2', account: 'A', amount: 30, crashAt: 'P2' },
  { kind: 'cancel', requestId: 'c1', txRef: 'p1' },
  { kind: 'cancel', requestId: 'c1', txRef: 'p1', crashAt: 'P2' },
  { kind: 'cancel', requestId: 'c2', txId: 'tx-999' },
  { kind: 'retry', requestId: 'p1' },
  { kind: 'retry', requestId: 'c1' },
  { kind: 'get', txRef: 'p1' },
];

function resolveTx(lookup, op) {
  if (op.txId) return op.txId;
  const found = lookup(op.txRef);
  return found.ok ? found.txId : 'tx-unresolved';
}

function runRealOp(dir, op) {
  const svc = new PaymentService(dir, { crashAt: op.crashAt ?? null });
  try {
    if (op.kind === 'pay') return svc.pay({ requestId: op.requestId, account: op.account, amount: op.amount });
    if (op.kind === 'cancel') return svc.cancel({ requestId: op.requestId, txId: resolveTx((r) => svc.getResultByRequestId(r), op) });
    if (op.kind === 'retry') return svc.retry({ requestId: op.requestId });
    if (op.kind === 'get') return svc.getTransaction(resolveTx((r) => svc.getResultByRequestId(r), op));
    throw new Error(`bad op ${op.kind}`);
  } catch (err) {
    if (err instanceof CrashSimulated) return CRASH;
    throw err;
  } finally {
    if (!svc.crashed) svc.close();
  }
}

function runModelOp(model, op) {
  try {
    if (op.kind === 'pay') return model.pay({ requestId: op.requestId, account: op.account, amount: op.amount }, op.crashAt ?? null);
    if (op.kind === 'cancel') return model.cancel({ requestId: op.requestId, txId: resolveTx((r) => model.getResultByRequestId(r), op) }, op.crashAt ?? null);
    if (op.kind === 'retry') return model.retry({ requestId: op.requestId }, op.crashAt ?? null);
    if (op.kind === 'get') return model.getTransaction(resolveTx((r) => model.getResultByRequestId(r), op));
    throw new Error(`bad op ${op.kind}`);
  } catch (err) {
    if (err instanceof ModelCrash) return CRASH;
    throw err;
  }
}

function checkSequence(sequence) {
  const dir = db();
  const model = new ModelSystem();
  for (const op of sequence) {
    const real = runRealOp(dir, op);
    const expected = runModelOp(model, op);
    assert.deepEqual(real, expected, `response mismatch for ${JSON.stringify(op)} in ${JSON.stringify(sequence)}`);
  }
  const realState = new PaymentService(dir).dumpState();
  const modelState = model.dumpState();
  assert.equal(realState.balances.A, modelState.balances.A, `balance mismatch in ${JSON.stringify(sequence)}`);
  assert.deepEqual(
    { balances: realState.balances, transactions: realState.transactions, idem: realState.idem },
    modelState,
    `state mismatch in ${JSON.stringify(sequence)}`,
  );
}

test('exhaustive enumeration of length-3 request sequences matches the model', () => {
  let count = 0;
  for (const a of OP_POOL) {
    for (const b of OP_POOL) {
      for (const c of OP_POOL) {
        checkSequence([a, b, c]);
        count += 1;
      }
    }
  }
  assert.equal(count, OP_POOL.length ** 3);
});

test('seeded random length-8 sequences match the model', () => {
  let seed = 0xC0FFEE;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let i = 0; i < 150; i++) {
    const sequence = [];
    for (let j = 0; j < 8; j++) sequence.push(OP_POOL[rand() % OP_POOL.length]);
    checkSequence(sequence);
  }
});
