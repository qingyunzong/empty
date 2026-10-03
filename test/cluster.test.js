import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Cluster,
  ReplicaError,
  visibleValue,
  NOT_MEMBER,
  EPOCH_MISMATCH,
  QUORUM_FAIL,
} from '../src/cluster.js';

function assertCode(fn, code) {
  assert.throws(fn, (e) => e instanceof ReplicaError && e.code === code);
}

// Deterministic PRNG for the randomized convergence test.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 1: scale 3 -> 5 -> 3, stale-epoch writes rejected', () => {
  const c = new Cluster();
  c.join('n1'); // epoch 1
  c.join('n2'); // epoch 2
  c.join('n3'); // epoch 3
  assert.equal(c.epoch, 3);

  const w1 = c.write({ node: 'n1', key: 'temp', value: 20, epoch: 3 });
  assert.equal(w1.acks, 3);
  assert.ok(w1.acks >= c.quorum());

  c.join('n4'); // epoch 4
  c.join('n5'); // epoch 5
  assert.equal(c.activeIds().length, 5);

  // Old-epoch write rejected after expansion.
  assertCode(() => c.write({ node: 'n1', key: 'temp', value: 21, epoch: 3 }), EPOCH_MISMATCH);
  const w2 = c.write({ node: 'n2', key: 'temp', value: 22, epoch: 5 });
  assert.equal(w2.acks, 5);

  c.leave('n4'); // epoch 6
  c.leave('n5'); // epoch 7
  assert.deepEqual(c.activeIds(), ['n1', 'n2', 'n3']);

  // Old-epoch write rejected after shrink.
  assertCode(() => c.write({ node: 'n1', key: 'temp', value: 23, epoch: 5 }), EPOCH_MISMATCH);
  const w3 = c.write({ node: 'n1', key: 'temp', value: 24, epoch: 7 });
  assert.equal(w3.acks, 3);

  // Tombstoned nodes cannot vote/write but stay auditable.
  assertCode(() => c.write({ node: 'n4', key: 'temp', value: 99, epoch: 7 }), NOT_MEMBER);
  assertCode(() => c.read({ node: 'n5', key: 'temp', epoch: 7 }), NOT_MEMBER);
  assert.equal(c.members.get('n4').status, 'tombstone');
  assert.equal(c.members.get('n5').leftEpoch, 7);
  assert.deepEqual(
    c.history.filter((h) => h.action === 'leave').map((h) => h.node),
    ['n4', 'n5']
  );
  assert.ok(c.nodes.get('n4').log.length > 0, 'tombstone history preserved for audit');

  const r = c.read({ node: 'n3', key: 'temp', epoch: 7 });
  assert.equal(r.value, 24);
  assert.equal(r.certificate.epoch, 7);
  assert.deepEqual(r.certificate.signers, ['n1', 'n2', 'n3']);
  assert.deepEqual(Object.keys(r.certificate.vector).sort(), ['n1', 'n2']);
});

test('acceptance 2: partition with message drops, majority side recovers', () => {
  const c = new Cluster();
  for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) c.join(id);
  const epoch = c.epoch; // 5
  assert.equal(c.quorum(), 3);

  c.partition([['n1', 'n2', 'n3'], ['n4', 'n5']]);

  // Majority side still commits.
  const w = c.write({ node: 'n1', key: 'humidity', value: 60, epoch });
  assert.deepEqual(w.signers, ['n1', 'n2', 'n3']);
  const r1 = c.read({ node: 'n2', key: 'humidity', epoch });
  assert.equal(r1.value, 60);
  assert.equal(r1.certificate.signers.length, 3);

  // Minority side cannot reach quorum for writes or reads.
  assertCode(() => c.write({ node: 'n4', key: 'humidity', value: 61, epoch }), QUORUM_FAIL);
  assertCode(() => c.read({ node: 'n5', key: 'humidity', epoch }), QUORUM_FAIL);

  // Heal + anti-entropy: minority side recovers the committed value.
  c.heal();
  c.repair();
  const r2 = c.read({ node: 'n5', key: 'humidity', epoch });
  assert.equal(r2.value, 60);
  assert.equal(r2.certificate.signers.length, 5);
});

test('acceptance 3: repair converges to brute-force full-copy state', () => {
  const rand = mulberry32(42);
  const c = new Cluster();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (const id of ids) c.join(id);
  const keys = ['temp', 'humidity', 'pressure'];

  // Randomized churn: partitions, heals, writes (some dropped/failed).
  for (let step = 0; step < 60; step++) {
    const roll = rand();
    if (roll < 0.35) {
      const shuffled = [...ids].sort(() => rand() - 0.5);
      const cut = 1 + Math.floor(rand() * (ids.length - 1));
      c.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
    } else if (roll < 0.55) {
      c.heal();
    } else {
      const node = ids[Math.floor(rand() * ids.length)];
      const key = keys[Math.floor(rand() * keys.length)];
      try {
        c.write({ node, key, value: Math.floor(rand() * 1000), epoch: c.epoch });
      } catch (e) {
        assert.equal(e.code, QUORUM_FAIL);
      }
    }
  }

  c.heal();
  c.repair();

  // Brute-force reference: union of every node's log, same visibility rule.
  const allEntries = [];
  const seen = new Set();
  for (const id of c.activeIds()) {
    for (const e of c.nodeState(id).log) {
      const k = `${e.origin}:${e.seq}`;
      if (!seen.has(k)) { seen.add(k); allEntries.push(e); }
    }
  }
  const expected = {};
  for (const key of keys) {
    expected[key] = visibleValue(allEntries.filter((e) => e.key === key)) ?? null;
  }

  // After repair every active node individually matches the brute-force state.
  for (const id of c.activeIds()) {
    const log = c.nodeState(id).log;
    for (const key of keys) {
      const got = visibleValue(log.filter((e) => e.key === key)) ?? null;
      assert.equal(got, expected[key], `node ${id} key ${key}`);
    }
  }

  // And quorum reads agree.
  for (const key of keys) {
    const r = c.read({ node: 'a', key, epoch: c.epoch });
    assert.equal(r.value, expected[key]);
  }
});

test('acceptance 4: repeated join is idempotent', () => {
  const c = new Cluster();
  const j1 = c.join('n1');
  assert.equal(j1.epoch, 1);
  assert.equal(j1.idempotent, false);

  const before = JSON.stringify(c.status());
  const j2 = c.join('n1');
  assert.equal(j2.idempotent, true);
  assert.equal(j2.epoch, 1, 'epoch not bumped');
  assert.equal(JSON.stringify(c.status()), before, 'state unchanged');

  c.join('n2');
  c.join('n2');
  assert.equal(c.epoch, 2);
  assert.equal(c.history.filter((h) => h.action === 'join').length, 2);

  // Rejoin after leave is a real membership change (not idempotent).
  c.leave('n2');
  const re = c.join('n2');
  assert.equal(re.idempotent, false);
  assert.equal(c.epoch, 4);
  assert.equal(c.members.get('n2').status, 'active');
});

test('error codes: NOT_MEMBER / EPOCH_MISMATCH / QUORUM_FAIL', () => {
  const c = new Cluster();
  c.join('n1');
  c.join('n2');
  c.join('n3');

  assertCode(() => c.write({ node: 'ghost', key: 'k', value: 1, epoch: 3 }), NOT_MEMBER);
  assertCode(() => c.read({ node: 'ghost', key: 'k', epoch: 3 }), NOT_MEMBER);
  assertCode(() => c.leave('ghost'), NOT_MEMBER);
  assertCode(() => c.write({ node: 'n1', key: 'k', value: 1, epoch: 99 }), EPOCH_MISMATCH);
  assertCode(() => c.read({ node: 'n1', key: 'k', epoch: 0 }), EPOCH_MISMATCH);

  // Isolate n1: self-only delivery is below quorum.
  c.partition([['n1'], ['n2', 'n3']]);
  assertCode(() => c.write({ node: 'n1', key: 'k', value: 1, epoch: 3 }), QUORUM_FAIL);
});

test('read certificate carries epoch, signers and merged vector', () => {
  const c = new Cluster();
  c.join('n1');
  c.join('n2');
  c.join('n3');
  c.write({ node: 'n1', key: 'x', value: 1, epoch: 3 });
  c.write({ node: 'n2', key: 'x', value: 2, epoch: 3 });
  const r = c.read({ node: 'n3', key: 'x', epoch: 3 });
  assert.equal(r.value, 2, 'causally later write wins');
  assert.deepEqual(r.certificate, {
    epoch: 3,
    signers: ['n1', 'n2', 'n3'],
    vector: { n1: 1, n2: 1 },
  });
});
