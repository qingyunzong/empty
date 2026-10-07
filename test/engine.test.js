import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger, verifyLog, ERRORS, STATUS } from '../src/engine.js';

const deposit = (id, clock, amount) => ({ clientOpId: id, clock, type: 'deposit', amount });
const authorize = (id, clock, amount, ttl) => ({ clientOpId: id, clock, type: 'authorize', amount, ...(ttl === undefined ? {} : { ttl }) });
const confirm = (id, clock, parent) => ({ clientOpId: id, clock, type: 'confirm', parent });
const capture = (id, clock, parent, amount) => ({ clientOpId: id, clock, type: 'capture', parent, amount });
const voidOp = (id, clock, parent, amount) => ({ clientOpId: id, clock, type: 'void', parent, ...(amount === undefined ? {} : { amount }) });
const expire = (id, clock, parent, slot, outcome) => ({ clientOpId: id, clock, type: 'expire', parent, slot, ...(outcome === undefined ? {} : { outcome }) });

test('over-limit freeze fails with INSUFFICIENT and leaves state untouched', () => {
  const ledger = new Ledger();
  ledger.submit(deposit('d1', 1, 50));
  const result = ledger.submit(authorize('a1', 2, 80));
  assert.equal(result.status, STATUS.ERROR);
  assert.equal(result.error, ERRORS.INSUFFICIENT);
  assert.equal(ledger.view.available, 50);
  assert.equal(ledger.view.frozen, 0);
  assert.equal(ledger.view.holds.length, 0);
});

test('authorize -> confirm -> capture moves funds out of frozen', () => {
  const ledger = new Ledger();
  ledger.submitAll([
    deposit('d1', 1, 100),
    authorize('a1', 2, 40),
    confirm('c1', 3, 'a1'),
    capture('p1', 4, 'a1', 25),
  ]);
  assert.equal(ledger.view.available, 60);
  assert.equal(ledger.view.frozen, 15);
  assert.equal(ledger.view.captured, 25);
  const hold = ledger.view.holds[0];
  assert.equal(hold.status, 'CONFIRMED');
  assert.equal(hold.remaining, 15);
  assert.equal(hold.captured, 25);
});

test('partial void chain restores funds and cumulative voids cannot exceed the original', () => {
  const ledger = new Ledger();
  ledger.submitAll([
    deposit('d1', 1, 100),
    authorize('a1', 2, 60),
    confirm('c1', 3, 'a1'),
    voidOp('v1', 4, 'a1', 10),
    voidOp('v2', 5, 'a1', 20),
  ]);
  assert.equal(ledger.view.available, 70);
  assert.equal(ledger.view.frozen, 30);

  const tooMuch = ledger.submit(voidOp('v3', 6, 'a1', 31));
  assert.equal(tooMuch.status, STATUS.ERROR);
  assert.equal(tooMuch.error, ERRORS.FROZEN);
  assert.equal(ledger.view.frozen, 30);

  const last = ledger.submit(voidOp('v4', 7, 'a1', 30));
  assert.equal(last.status, STATUS.APPLIED);
  assert.equal(ledger.view.available, 100);
  assert.equal(ledger.view.frozen, 0);
  assert.equal(ledger.view.holds[0].status, 'VOIDED');

  const again = ledger.submit(voidOp('v5', 8, 'a1', 1));
  assert.equal(again.status, STATUS.IDEMPOTENT);
  assert.equal(ledger.view.available, 100);
});

test('full void without amount releases the remaining frozen funds', () => {
  const ledger = new Ledger();
  ledger.submitAll([
    deposit('d1', 1, 90),
    authorize('a1', 2, 90),
    confirm('c1', 3, 'a1'),
    voidOp('v1', 4, 'a1'),
  ]);
  assert.equal(ledger.view.available, 90);
  assert.equal(ledger.view.frozen, 0);
  assert.equal(ledger.view.holds[0].status, 'VOIDED');
});

test('void and capture require a confirmed ancestor (BAD_PARENT)', () => {
  const ledger = new Ledger();
  ledger.submitAll([deposit('d1', 1, 100), authorize('a1', 2, 50)]);

  const voidPending = ledger.submit(voidOp('v1', 3, 'a1', 10));
  assert.equal(voidPending.error, ERRORS.BAD_PARENT);

  const capturePending = ledger.submit(capture('p1', 3, 'a1', 10));
  assert.equal(capturePending.error, ERRORS.BAD_PARENT);

  const voidGhost = ledger.submit(voidOp('v2', 3, 'nope', 10));
  assert.equal(voidGhost.error, ERRORS.BAD_PARENT);

  assert.equal(ledger.view.frozen, 50);
});

test('capture beyond remaining frozen fails with FROZEN', () => {
  const ledger = new Ledger();
  ledger.submitAll([
    deposit('d1', 1, 100),
    authorize('a1', 2, 40),
    confirm('c1', 3, 'a1'),
    capture('p1', 4, 'a1', 30),
  ]);
  const result = ledger.submit(capture('p2', 5, 'a1', 11));
  assert.equal(result.error, ERRORS.FROZEN);
  assert.equal(ledger.view.captured, 30);
});

test('PENDING hold resolves to EXPIRED or FAILED only via expire after its timeout slot', () => {
  const ledger = new Ledger();
  ledger.submitAll([deposit('d1', 1, 100), authorize('a1', 2, 60, 5)]);

  const early = ledger.submit(expire('e1', 3, 'a1', 6));
  assert.equal(early.error, ERRORS.TIME_TRAVEL);
  assert.equal(ledger.view.frozen, 60);
  assert.equal(ledger.view.holds[0].status, 'PENDING');

  const onSlot = ledger.submit(expire('e2', 4, 'a1', 7));
  assert.equal(onSlot.status, STATUS.APPLIED);
  assert.equal(ledger.view.available, 100);
  assert.equal(ledger.view.frozen, 0);
  assert.equal(ledger.view.holds[0].status, 'EXPIRED');

  const again = ledger.submit(expire('e3', 5, 'a1', 8));
  assert.equal(again.status, STATUS.IDEMPOTENT);

  const ledger2 = new Ledger();
  ledger2.submitAll([deposit('d1', 1, 10), authorize('a1', 2, 10, 1), expire('e1', 3, 'a1', 3, 'FAILED')]);
  assert.equal(ledger2.view.holds[0].status, 'FAILED');
  assert.equal(ledger2.view.available, 10);
});

test('exact duplicate submission is idempotent; same clientOpId with different payload is DUP_OP', () => {
  const ledger = new Ledger();
  const op = deposit('d1', 1, 50);
  const first = ledger.submit(op);
  assert.equal(first.status, STATUS.APPLIED);
  const logLength = ledger.log.length;

  const dup = ledger.submit(op);
  assert.equal(dup.status, STATUS.APPLIED);
  assert.equal(dup.dedup, true);
  assert.equal(ledger.log.length, logLength);
  assert.equal(ledger.view.available, 50);

  ledger.submit(authorize('a1', 2, 20));
  const conflict = ledger.submit(authorize('a1', 3, 30));
  assert.equal(conflict.status, STATUS.ERROR);
  assert.equal(conflict.error, ERRORS.DUP_OP);
  assert.equal(ledger.view.frozen, 20);
});

test('child op with clock not greater than its ancestor is TIME_TRAVEL', () => {
  const ledger = new Ledger();
  ledger.submitAll([deposit('d1', 1, 100), authorize('a1', 5, 40), confirm('c1', 6, 'a1')]);
  const equal = ledger.submit(voidOp('v1', 5, 'a1', 10));
  assert.equal(equal.error, ERRORS.TIME_TRAVEL);
  const backwards = ledger.submit(voidOp('v2', 4, 'a1', 10));
  assert.equal(backwards.error, ERRORS.TIME_TRAVEL);
  assert.equal(ledger.view.frozen, 40);
});

test('out-of-order concurrent submissions linearize to the same final state and head', () => {
  const ops = [
    deposit('d1', 1, 200),
    authorize('a1', 2, 70),
    authorize('a2', 2, 50),
    confirm('c1', 3, 'a1'),
    confirm('c2', 3, 'a2'),
    capture('p1', 4, 'a1', 20),
    voidOp('v1', 4, 'a2', 10),
    voidOp('v2', 5, 'a1', 30),
    expire('e1', 6, 'a2', 20),
  ];
  const forward = new Ledger();
  forward.submitAll(ops);
  const backward = new Ledger();
  backward.submitAll([...ops].reverse());
  const interleaved = new Ledger();
  interleaved.submitAll([ops[4], ops[0], ops[7], ops[2], ops[5], ops[8], ops[1], ops[6], ops[3]]);

  assert.deepEqual(backward.view, forward.view);
  assert.deepEqual(interleaved.view, forward.view);
  assert.equal(backward.head, forward.head);
  assert.equal(interleaved.head, forward.head);
  assert.equal(forward.view.available, 200 - 70 - 50 + 20 * 0 + 30 + 10 + 40 - 0);
  assert.equal(forward.view.captured, 20);
});

test('hash chain verifies and detects tampering', () => {
  const ledger = new Ledger();
  ledger.submitAll([deposit('d1', 1, 100), authorize('a1', 2, 40), confirm('c1', 3, 'a1')]);
  const log = ledger.log;
  assert.equal(verifyLog(log), true);
  assert.equal(log[log.length - 1].hash, ledger.head);

  const tampered = log.map((entry, i) =>
    i === 1 ? { ...entry, result: { status: 'ERROR', error: 'INSUFFICIENT' } } : entry,
  );
  assert.equal(verifyLog(tampered), false);

  const truncated = log.slice(0, -1);
  assert.equal(verifyLog(truncated), true);
  assert.notEqual(truncated[truncated.length - 1].hash, ledger.head);
});

test('replay from the submitted op log reproduces the identical final state', () => {
  const ops = [
    deposit('d1', 3, 500),
    authorize('a1', 1, 100),
    authorize('a2', 2, 200, 4),
    confirm('c2', 5, 'a2'),
    voidOp('v1', 6, 'a2', 50),
    expire('e1', 7, 'a1', 20),
    capture('p1', 8, 'a2', 100),
  ];
  const first = new Ledger();
  first.submitAll(ops);
  const replayed = new Ledger();
  replayed.submitAll(ops.slice().sort(() => 0.5 - 0.5).reverse());
  assert.deepEqual(replayed.view, first.view);
  assert.equal(replayed.head, first.head);
  assert.equal(verifyLog(replayed.log), true);
});

test('malformed ops are rejected before any state change', () => {
  const ledger = new Ledger();
  ledger.submit(deposit('d1', 1, 10));
  const head = ledger.head;
  assert.throws(() => ledger.submit({ clientOpId: 'x', clock: 2, type: 'authorize', amount: -5 }), TypeError);
  assert.throws(() => ledger.submit({ clientOpId: '', clock: 2, type: 'deposit', amount: 5 }), TypeError);
  assert.throws(() => ledger.submit({ clientOpId: 'y', clock: 2, type: 'nonsense' }), TypeError);
  assert.equal(ledger.head, head);
  assert.equal(ledger.view.available, 10);
});
