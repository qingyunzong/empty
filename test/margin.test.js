'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  applyEvent,
  mergeStates,
  readPosition,
  getCertificate,
} = require('../margin');

const credit = (id, symbol, amount) => ({ id, type: 'credit', symbol, amount });
const freeze = (id, freezeId, symbol, amount) => ({ id, type: 'freeze', freezeId, symbol, amount });
const release = (id, freezeId, amount) => ({ id, type: 'release', freezeId, amount });

function applyAll(state, events) {
  for (const event of events) {
    const result = applyEvent(state, event);
    assert.equal(result.ok, true, `expected ok for ${JSON.stringify(event)}, got ${JSON.stringify(result)}`);
  }
}

test('acceptance 1: concurrent freezes on two replicas merge with correct available', () => {
  const replicaA = createState();
  const replicaB = createState();
  applyAll(replicaA, [credit('c1', 'ACME', 100)]);
  applyAll(replicaB, [credit('c1', 'ACME', 100)]);

  applyAll(replicaA, [freeze('e1', 'f1', 'ACME', 40)]);
  applyAll(replicaB, [freeze('e2', 'f2', 'ACME', 30)]);

  assert.equal(mergeStates(replicaA, replicaB).ok, true);
  assert.equal(mergeStates(replicaB, replicaA).ok, true);

  for (const replica of [replicaA, replicaB]) {
    const pos = readPosition(replica, 'ACME');
    assert.equal(pos.available, 30);
    assert.deepEqual(
      pos.frozen.map((f) => [f.freezeId, f.amount]),
      [['f1', 40], ['f2', 30]],
    );
  }
});

test('acceptance 2: partial releases accumulate, full release leaves tombstone', () => {
  const state = createState();
  applyAll(state, [credit('c1', 'ACME', 100), freeze('e1', 'f1', 'ACME', 40)]);

  applyAll(state, [release('r1', 'f1', 15)]);
  let pos = readPosition(state, 'ACME');
  assert.equal(pos.available, 75);
  assert.deepEqual(pos.frozen.map((f) => [f.freezeId, f.released]), [['f1', 15]]);
  assert.equal(pos.tombstones.length, 0);

  applyAll(state, [release('r2', 'f1', 25)]);
  pos = readPosition(state, 'ACME');
  assert.equal(pos.available, 100);
  assert.equal(pos.frozen.length, 0);
  assert.deepEqual(pos.tombstones.map((t) => [t.freezeId, t.amount, t.released]), [['f1', 40, 40]]);

  // Stale duplicate of an already-applied release event: idempotent no-op.
  const dup = applyEvent(state, release('r2', 'f1', 25));
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  pos = readPosition(state, 'ACME');
  assert.equal(pos.available, 100);
  assert.equal(pos.tombstones.length, 1);

  // A new release against the tombstoned freeze must not resurrect it.
  const late = applyEvent(state, release('r3', 'f1', 1));
  assert.equal(late.ok, false);
  assert.equal(late.error, 'over-release');
  pos = readPosition(state, 'ACME');
  assert.equal(pos.available, 100);
  assert.equal(pos.frozen.length, 0);
  assert.equal(pos.tombstones.length, 1);
});

test('acceptance 3: over-release, unknown-freeze, insufficient-margin', () => {
  const state = createState();
  applyAll(state, [credit('c1', 'ACME', 50), freeze('e1', 'f1', 'ACME', 20)]);

  let result = applyEvent(state, release('r1', 'f1', 21));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'over-release');

  result = applyEvent(state, release('r2', 'nope', 1));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unknown-freeze');

  result = applyEvent(state, freeze('e2', 'f2', 'ACME', 31));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'insufficient-margin');

  // Failed events must not be recorded: retrying with a valid payload is fine.
  assert.equal(applyEvent(state, freeze('e2', 'f2', 'ACME', 30)).ok, true);
});

test('idempotency: identical event id is a no-op, conflicting payload is rejected', () => {
  const state = createState();
  applyAll(state, [credit('c1', 'ACME', 100)]);

  const first = applyEvent(state, freeze('e1', 'f1', 'ACME', 40));
  assert.equal(first.ok, true);
  const again = applyEvent(state, freeze('e1', 'f1', 'ACME', 40));
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.equal(readPosition(state, 'ACME').available, 60);

  const conflict = applyEvent(state, freeze('e1', 'f1', 'ACME', 41));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, 'event-conflict');
  assert.equal(readPosition(state, 'ACME').available, 60);

  const conflictMerge = createState();
  applyAll(conflictMerge, [credit('c1', 'ACME', 100), freeze('e1', 'f1', 'ACME', 41)]);
  const merged = mergeStates(state, conflictMerge);
  assert.equal(merged.ok, false);
  assert.equal(merged.error, 'event-conflict');
});

test('certificate exposes symbol, available, frozen list and release hash', () => {
  const state = createState();
  applyAll(state, [
    credit('c1', 'ACME', 100),
    freeze('e1', 'f1', 'ACME', 40),
    freeze('e2', 'f2', 'ACME', 10),
    release('r1', 'f1', 15),
    release('r2', 'f2', 10),
  ]);
  const cert = getCertificate(state, 'ACME');
  assert.equal(cert.symbol, 'ACME');
  assert.equal(cert.available, 75);
  assert.deepEqual(cert.frozen.map((f) => [f.freezeId, f.amount, f.released]), [['f1', 40, 15]]);
  assert.match(cert.releaseHash, /^[0-9a-f]{64}$/);

  // Release hash changes when released amounts change.
  applyAll(state, [release('r3', 'f1', 5)]);
  assert.notEqual(getCertificate(state, 'ACME').releaseHash, cert.releaseHash);
});

// Independent reference summation table: a deliberately simple, separate
// implementation used to cross-check the library on enumerated inputs.
function referenceModel(events) {
  const seen = new Map();
  let available = 0;
  const frozen = new Map();
  const tombstones = new Map();
  const outcomes = [];
  for (const event of events) {
    const key = JSON.stringify(event);
    if (seen.has(event.id)) {
      outcomes.push(seen.get(event.id) === key ? 'duplicate' : 'event-conflict');
      if (seen.get(event.id) !== key) return { outcomes, conflict: true };
      continue;
    }
    if (event.type === 'credit') {
      available += event.amount;
    } else if (event.type === 'freeze') {
      if (event.amount > available) {
        outcomes.push('insufficient-margin');
        continue;
      }
      available -= event.amount;
      const entry = frozen.get(event.freezeId) || { amount: 0, released: 0 };
      entry.amount += event.amount;
      frozen.set(event.freezeId, entry);
    } else if (event.type === 'release') {
      const entry = frozen.get(event.freezeId) || tombstones.get(event.freezeId);
      if (!entry) {
        outcomes.push('unknown-freeze');
        continue;
      }
      if (entry.released + event.amount > entry.amount) {
        outcomes.push('over-release');
        continue;
      }
      entry.released += event.amount;
      available += event.amount;
      if (frozen.has(event.freezeId) && entry.released === entry.amount) {
        frozen.delete(event.freezeId);
        tombstones.set(event.freezeId, entry);
      }
    }
    seen.set(event.id, key);
    outcomes.push('applied');
  }
  return { outcomes, conflict: false, available, frozen, tombstones };
}

function summarize(state) {
  const pos = readPosition(state, 'ACME');
  return {
    available: pos.available,
    frozen: pos.frozen.map((f) => [f.freezeId, f.amount, f.released]),
    tombstones: pos.tombstones.map((t) => [t.freezeId, t.amount, t.released]),
  };
}

const EVENT_POOL = [
  credit('c1', 'ACME', 100),
  freeze('e1', 'f1', 'ACME', 40),
  freeze('e2', 'f2', 'ACME', 30),
  release('r1', 'f1', 25),
  release('r2', 'f1', 15),
  release('r3', 'f2', 10),
];

test('enumeration: every subset with duplicates matches the reference table', () => {
  // Each pool event may appear 0, 1 or 2 times -> 3^6 = 729 combinations.
  const counts = new Array(EVENT_POOL.length).fill(0);
  let checked = 0;
  for (;;) {
    const events = [];
    EVENT_POOL.forEach((event, i) => {
      for (let k = 0; k < counts[i]; k += 1) events.push(event);
    });

    const expected = referenceModel(events);
    const state = createState();
    const actualOutcomes = [];
    let conflict = false;
    for (const event of events) {
      const result = applyEvent(state, event);
      if (!result.ok) {
        actualOutcomes.push(result.error);
        if (result.error === 'event-conflict') {
          conflict = true;
          break;
        }
      } else {
        actualOutcomes.push(result.duplicate ? 'duplicate' : 'applied');
      }
    }

    assert.deepEqual(actualOutcomes, expected.outcomes, `outcomes for ${JSON.stringify(counts)}`);
    assert.equal(conflict, expected.conflict);
    if (!conflict) {
      const summary = summarize(state);
      assert.equal(summary.available, expected.available, `available for ${JSON.stringify(counts)}`);
      assert.deepEqual(
        summary.frozen,
        [...expected.frozen.entries()].map(([id, e]) => [id, e.amount, e.released]).sort(),
        `frozen for ${JSON.stringify(counts)}`,
      );
      assert.deepEqual(
        summary.tombstones,
        [...expected.tombstones.entries()].map(([id, e]) => [id, e.amount, e.released]).sort(),
        `tombstones for ${JSON.stringify(counts)}`,
      );
    }
    checked += 1;

    let i = 0;
    while (i < counts.length) {
      counts[i] += 1;
      if (counts[i] < 3) break;
      counts[i] = 0;
      i += 1;
    }
    if (i === counts.length) break;
  }
  assert.equal(checked, 729);
});

test('enumeration: merges of replica subsets converge to the reference table', () => {
  // Replicas share the credit, then each applies a distinct subset of events.
  const shared = EVENT_POOL[0];
  const pool = EVENT_POOL.slice(1);
  for (let maskA = 0; maskA < (1 << pool.length); maskA += 1) {
    for (let maskB = 0; maskB < (1 << pool.length); maskB += 1) {
      const eventsA = [shared, ...pool.filter((_, i) => maskA & (1 << i))];
      const eventsB = [shared, ...pool.filter((_, i) => maskB & (1 << i))];
      const replicaA = createState();
      const replicaB = createState();
      const outcomesA = eventsA.map((e) => applyEvent(replicaA, e));
      const outcomesB = eventsB.map((e) => applyEvent(replicaB, e));
      // Only compare fully-successful replicas; failed events leave no trace.
      if (outcomesA.some((r) => !r.ok) || outcomesB.some((r) => !r.ok)) continue;

      assert.equal(mergeStates(replicaA, replicaB).ok, true, `merge ${maskA} ${maskB}`);
      assert.equal(mergeStates(replicaB, replicaA).ok, true, `merge ${maskB} ${maskA}`);

      const unionEvents = [shared];
      const seenIds = new Set([shared.id]);
      for (const e of [...eventsA, ...eventsB]) {
        if (!seenIds.has(e.id)) {
          seenIds.add(e.id);
          unionEvents.push(e);
        }
      }
      const expected = referenceModel(unionEvents);
      for (const replica of [replicaA, replicaB]) {
        const summary = summarize(replica);
        assert.equal(summary.available, expected.available, `available ${maskA} ${maskB}`);
        assert.deepEqual(
          summary.frozen,
          [...expected.frozen.entries()].map(([id, e]) => [id, e.amount, e.released]).sort(),
        );
        assert.deepEqual(
          summary.tombstones,
          [...expected.tombstones.entries()].map(([id, e]) => [id, e.amount, e.released]).sort(),
        );
      }
    }
  }
});
