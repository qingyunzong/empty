import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent,
  balance,
  createReplica,
  diff,
  merge,
  summary,
} from '../src/replica.js';

const LIMIT = 1000;

function reserve(id, account, amount) {
  return { type: 'reserve', requestId: id, account, amount };
}

function release(id, reservationId, amount) {
  return { type: 'release', requestId: id, reservationId, amount };
}

// Full anti-entropy round in both directions.
function sync(a, b) {
  const toB = diff(a, summary(b));
  assert.equal(merge(b, toB).ok, true);
  const toA = diff(b, summary(a));
  assert.equal(merge(a, toA).ok, true);
}

// Independent reference model: a plain balance table keyed by reservation id,
// maintained without any of the library code.
function makeReference() {
  const table = new Map();
  return {
    reserve(id, amount) {
      table.set(id, (table.get(id) ?? 0) + amount);
    },
    release(id, amount) {
      table.set(id, table.get(id) - amount);
    },
    reserved() {
      let total = 0;
      for (const v of table.values()) total += v;
      return total;
    },
  };
}

test('acceptance 1: concurrent reservations on two replicas both consume quota after repair', () => {
  const a = createReplica(400);
  const b = createReplica(400);
  assert.equal(applyEvent(a, reserve('r-a', 'acct-a', 100)).ok, true);
  assert.equal(applyEvent(b, reserve('r-b', 'acct-b', 150)).ok, true);

  // Before sync each replica only sees its own reservation.
  assert.equal(balance(a).reserved, 100);
  assert.equal(balance(b).reserved, 150);

  sync(a, b);

  // After repair both replicas deduct both reservations.
  assert.deepEqual(balance(a), { limit: 400, reserved: 250, available: 150 });
  assert.deepEqual(balance(b), { limit: 400, reserved: 250, available: 150 });
  assert.equal(summary(a).digest, summary(b).digest);
});

test('acceptance 1b: merged reservations count even when they exceed the local limit', () => {
  const a = createReplica(200);
  const b = createReplica(200);
  applyEvent(a, reserve('r-a', 'acct-a', 120));
  applyEvent(b, reserve('r-b', 'acct-b', 120));
  sync(a, b);
  assert.equal(balance(a).reserved, 240);
  assert.equal(balance(b).reserved, 240);
  assert.equal(balance(a).available, -40);
});

test('acceptance 2: missing release is filled by repair; stale duplicate release is blocked by tombstone', () => {
  const a = createReplica(LIMIT);
  const b = createReplica(LIMIT);
  const r1 = reserve('r1', 'acct', 100);
  const rel1 = release('rel1', 'r1', 60);
  applyEvent(a, r1);
  applyEvent(a, rel1);
  applyEvent(b, r1); // B saw the reservation but missed the release.

  // Anti-entropy: B learns it is missing exactly the release event.
  const missing = diff(a, summary(b));
  assert.deepEqual(missing, [rel1]);
  assert.equal(merge(b, missing).ok, true);
  assert.equal(balance(b).reserved, 40);
  assert.equal(balance(a).reserved, 40);

  // Replaying the same release (same id, same payload) is an idempotent no-op.
  const replay = applyEvent(b, rel1);
  assert.equal(replay.ok, true);
  assert.equal(replay.changed, false);
  assert.equal(balance(b).reserved, 40);

  // Fully release on A and propagate; the reservation becomes a tombstone.
  const rel2 = release('rel2', 'r1', 40);
  applyEvent(a, rel2);
  sync(a, b);
  assert.equal(balance(a).reserved, 0);
  assert.equal(balance(b).reserved, 0);
  assert.equal(a.reservations.r1.status, 'released');
  assert.equal(b.reservations.r1.status, 'released');

  // A stale, distinct release against the fully released reservation is
  // rejected as over-release on both replicas.
  assert.equal(applyEvent(a, release('rel-stale', 'r1', 1)).error, 'over-release');
  assert.equal(applyEvent(b, release('rel-stale', 'r1', 1)).error, 'over-release');

  // Re-merging the original reservation event cannot resurrect the tombstone.
  assert.equal(merge(b, [r1]).ok, true);
  assert.equal(b.reservations.r1.status, 'released');
  assert.equal(balance(b).reserved, 0);
});

test('acceptance 3: limit-exceeded on over-reservation, over-release on over-release', () => {
  const r = createReplica(500);
  assert.equal(applyEvent(r, reserve('big', 'acct', 600)).error, 'limit-exceeded');
  assert.equal(applyEvent(r, reserve('ok', 'acct', 300)).ok, true);
  assert.equal(applyEvent(r, release('x1', 'ok', 400)).error, 'over-release');
  assert.equal(applyEvent(r, release('x2', 'ok', 300)).ok, true);
  // Reservation fully released: any further release hits the tombstone.
  assert.equal(applyEvent(r, release('x3', 'ok', 1)).error, 'over-release');
  // Partial releases accumulate toward the limit.
  applyEvent(r, reserve('p', 'acct', 100));
  assert.equal(applyEvent(r, release('y1', 'p', 60)).ok, true);
  assert.equal(applyEvent(r, release('y2', 'p', 41)).error, 'over-release');
  assert.equal(applyEvent(r, release('y3', 'p', 40)).ok, true);
});

test('idempotency and conflict: same id + same payload is a no-op, same id + different payload is rejected', () => {
  const r = createReplica(LIMIT);
  const e = reserve('r1', 'acct', 50);
  assert.deepEqual(applyEvent(r, e), { ok: true, changed: true });
  assert.deepEqual(applyEvent(r, e), { ok: true, changed: false });
  assert.equal(applyEvent(r, reserve('r1', 'acct', 51)).error, 'conflict');
  assert.equal(applyEvent(r, reserve('r1', 'other', 50)).error, 'conflict');

  const rel = release('rel1', 'r1', 20);
  assert.deepEqual(applyEvent(r, rel), { ok: true, changed: true });
  assert.deepEqual(applyEvent(r, rel), { ok: true, changed: false });
  assert.equal(applyEvent(r, release('rel1', 'r1', 21)).error, 'conflict');
  assert.equal(balance(r).reserved, 30);
});

// Enumerate every presence/absence combination of a reserve and a release on
// each of the two replicas (2^4 = 16 cases) and check the post-sync balances
// against an independent reference balance table.
test('enumeration: reserve/release presence combinations on two replicas match reference balances', () => {
  const A_RES = { id: 'a-res', account: 'acct-a', amount: 30 };
  const A_REL = { id: 'a-rel', amount: 10 };
  const B_RES = { id: 'b-res', account: 'acct-b', amount: 40 };
  const B_REL = { id: 'b-rel', amount: 15 };

  for (const aHasReserve of [false, true]) {
    for (const aHasRelease of [false, true]) {
      for (const bHasReserve of [false, true]) {
        for (const bHasRelease of [false, true]) {
          const label = `a(res=${aHasReserve},rel=${aHasRelease}) b(res=${bHasReserve},rel=${bHasRelease})`;
          const a = createReplica(LIMIT);
          const b = createReplica(LIMIT);
          const reference = makeReference();

          // A release without its reservation locally must be rejected.
          if (aHasRelease && !aHasReserve) {
            assert.equal(
              applyEvent(a, release(A_REL.id, A_RES.id, A_REL.amount)).error,
              'unknown-reservation',
              label,
            );
          }
          if (bHasRelease && !bHasReserve) {
            assert.equal(
              applyEvent(b, release(B_REL.id, B_RES.id, B_REL.amount)).error,
              'unknown-reservation',
              label,
            );
          }

          if (aHasReserve) {
            assert.equal(applyEvent(a, reserve(A_RES.id, A_RES.account, A_RES.amount)).ok, true, label);
            reference.reserve(A_RES.id, A_RES.amount);
            if (aHasRelease) {
              assert.equal(applyEvent(a, release(A_REL.id, A_RES.id, A_REL.amount)).ok, true, label);
              reference.release(A_RES.id, A_REL.amount);
            }
          }
          if (bHasReserve) {
            assert.equal(applyEvent(b, reserve(B_RES.id, B_RES.account, B_RES.amount)).ok, true, label);
            reference.reserve(B_RES.id, B_RES.amount);
            if (bHasRelease) {
              assert.equal(applyEvent(b, release(B_REL.id, B_RES.id, B_REL.amount)).ok, true, label);
              reference.release(B_RES.id, B_REL.amount);
            }
          }

          sync(a, b);

          const expectedReserved = reference.reserved();
          for (const [name, replica] of [['a', a], ['b', b]]) {
            assert.equal(balance(replica).reserved, expectedReserved, `${label} replica ${name} reserved`);
            assert.equal(balance(replica).available, LIMIT - expectedReserved, `${label} replica ${name} available`);
            assert.equal(balance(replica).limit, LIMIT, `${label} replica ${name} limit`);
          }
          assert.equal(summary(a).digest, summary(b).digest, `${label} digests converge`);
        }
      }
    }
  }
});

test('merge rejects conflicting payloads and invalid events', () => {
  const a = createReplica(LIMIT);
  applyEvent(a, reserve('r1', 'acct', 50));
  // Same requestId arriving with a divergent payload is rejected.
  assert.equal(merge(a, [reserve('r1', 'acct', 60)]).error, 'conflict');
  assert.equal(merge(a, [release('r1', 'r1', 10)]).error, 'conflict');
  // The failed merge leaves the replica untouched.
  assert.equal(balance(a).reserved, 50);
  assert.equal(merge(a, [{ type: 'reserve', requestId: '', account: 'x', amount: 1 }]).error, 'invalid-event');
  assert.equal(merge(a, 'not-an-array').error, 'invalid-event');
});
