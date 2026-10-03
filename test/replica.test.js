'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ReplicaError,
  createState,
  balance,
  applyReserve,
  applyRelease,
  digest,
  diff,
  merge,
} = require('../src/replica');

function syncBoth(a, b) {
  merge(a, b);
  merge(b, a);
}

test('acceptance 1: concurrent reservations on two replicas both consume limit after repair', () => {
  const a = createState(1000);
  const b = createState(1000);

  applyReserve(a, { requestId: 'r-a', account: 'alice', amount: 400 });
  applyReserve(b, { requestId: 'r-b', account: 'bob', amount: 300 });

  assert.equal(balance(a).available, 600);
  assert.equal(balance(b).available, 700);

  const missingForB = diff(a, b);
  assert.equal(missingForB.missing.length, 1);
  assert.equal(missingForB.missing[0].requestId, 'r-a');

  syncBoth(a, b);

  assert.equal(balance(a).available, 300);
  assert.equal(balance(b).available, 300);
  assert.equal(balance(a).reserved, 700);
  assert.equal(balance(b).reserved, 700);
  assert.equal(digest(a), digest(b));
});

test('acceptance 2: backfilled release fixes balance, stale duplicate blocked by tombstone', () => {
  const a = createState(1000);
  const b = createState(1000);

  applyReserve(a, { requestId: 'r1', account: 'alice', amount: 500 });
  merge(b, a);
  assert.equal(balance(b).available, 500);

  applyRelease(a, { requestId: 'x1', target: 'r1', amount: 200 });
  assert.equal(balance(b).available, 500, 'b still misses the release');

  merge(b, a);
  assert.equal(balance(b).available, 700, 'release backfilled');

  const dup = applyRelease(b, { requestId: 'x1', target: 'r1', amount: 200 });
  assert.equal(dup.applied, false, 'tombstone blocks stale duplicate release');
  assert.equal(balance(b).available, 700);

  assert.throws(
    () => applyRelease(b, { requestId: 'x1', target: 'r1', amount: 150 }),
    (error) => error instanceof ReplicaError && error.code === 'payload-conflict',
  );
  assert.equal(balance(b).available, 700);
});

test('acceptance 3: limit-exceeded on over-reserve, over-release on over-release', () => {
  const s = createState(100);
  assert.throws(
    () => applyReserve(s, { requestId: 'r1', account: 'a', amount: 101 }),
    (error) => error.code === 'limit-exceeded',
  );
  applyReserve(s, { requestId: 'r1', account: 'a', amount: 60 });
  assert.throws(
    () => applyRelease(s, { requestId: 'x1', target: 'r1', amount: 61 }),
    (error) => error.code === 'over-release',
  );
  applyRelease(s, { requestId: 'x1', target: 'r1', amount: 60 });
  assert.throws(
    () => applyRelease(s, { requestId: 'x2', target: 'r1', amount: 1 }),
    (error) => error.code === 'over-release',
  );
});

test('idempotency: same requestId with same payload is a no-op', () => {
  const s = createState(1000);
  const first = applyReserve(s, { requestId: 'r1', account: 'a', amount: 100 });
  const second = applyReserve(s, { requestId: 'r1', account: 'a', amount: 100 });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(balance(s).available, 900);
});

test('same requestId with different payload is rejected', () => {
  const s = createState(1000);
  applyReserve(s, { requestId: 'r1', account: 'a', amount: 100 });
  assert.throws(
    () => applyReserve(s, { requestId: 'r1', account: 'a', amount: 200 }),
    (error) => error.code === 'payload-conflict',
  );
  assert.throws(
    () => applyReserve(s, { requestId: 'r1', account: 'b', amount: 100 }),
    (error) => error.code === 'payload-conflict',
  );
});

test('release of unknown reserve is rejected', () => {
  const s = createState(1000);
  assert.throws(
    () => applyRelease(s, { requestId: 'x1', target: 'nope', amount: 10 }),
    (error) => error.code === 'unknown-reserve',
  );
});

test('enumeration: reserve/release presence matrix on two replicas vs reference table', () => {
  const LIMIT = 1000;
  const R1 = { requestId: 'req-a', account: 'alice', amount: 400 };
  const X1 = { requestId: 'rel-a', target: 'req-a', amount: 150 };
  const R2 = { requestId: 'req-b', account: 'bob', amount: 300 };
  const X2 = { requestId: 'rel-b', target: 'req-b', amount: 120 };

  // Presence combos per replica: release requires its reserve to exist locally.
  const combos = [
    { reserve: false, release: false },
    { reserve: true, release: false },
    { reserve: true, release: true },
  ];

  // Independent reference balance table, computed without library code.
  const reference = {};
  for (const c1 of combos) {
    for (const c2 of combos) {
      const key = `${Number(c1.reserve)}${Number(c1.release)}${Number(c2.reserve)}${Number(c2.release)}`;
      const reserved = (c1.reserve ? 400 : 0) + (c2.reserve ? 300 : 0);
      const released = (c1.release ? 150 : 0) + (c2.release ? 120 : 0);
      reference[key] = {
        reserved,
        released,
        outstanding: reserved - released,
        available: LIMIT - reserved + released,
      };
    }
  }

  for (const c1 of combos) {
    for (const c2 of combos) {
      const key = `${Number(c1.reserve)}${Number(c1.release)}${Number(c2.reserve)}${Number(c2.release)}`;
      const a = createState(LIMIT);
      const b = createState(LIMIT);

      if (c1.reserve) applyReserve(a, R1);
      if (c1.release) applyRelease(a, X1);
      if (c2.reserve) applyReserve(b, R2);
      if (c2.release) applyRelease(b, X2);

      syncBoth(a, b);

      const expected = reference[key];
      for (const [name, replica] of [['a', a], ['b', b]]) {
        const actual = balance(replica);
        assert.equal(actual.reserved, expected.reserved, `${key}/${name} reserved`);
        assert.equal(actual.released, expected.released, `${key}/${name} released`);
        assert.equal(actual.outstanding, expected.outstanding, `${key}/${name} outstanding`);
        assert.equal(actual.available, expected.available, `${key}/${name} available`);
      }
      assert.equal(digest(a), digest(b), `${key} digests converge`);
    }
  }
});

test('diff reports only events the peer is missing', () => {
  const a = createState(1000);
  const b = createState(1000);
  applyReserve(a, { requestId: 'r1', account: 'a', amount: 100 });
  applyReserve(a, { requestId: 'r2', account: 'a', amount: 50 });
  applyReserve(b, { requestId: 'r1', account: 'a', amount: 100 });

  const result = diff(a, b);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].requestId, 'r2');
  assert.match(result.digest, /^[0-9a-f]{64}$/);

  const empty = diff(b, a);
  assert.equal(empty.missing.length, 0, 'b has nothing that a lacks');
  assert.equal(diff(a, a).missing.length, 0);
});
