import test from 'node:test';
import assert from 'node:assert/strict';
import { ClearingHouse, verifyCertificate } from '../src/engine.js';

const inst = (id, over = {}) => ({
  id,
  institution: 'A',
  amount: 10,
  priority: 1,
  deadline: 2,
  deps: [],
  ...over,
});

function buildPreemptedHouse() {
  const house = new ClearingHouse({ slots: 2, capacity: 1 });
  const first = house.schedule([
    inst('low', { institution: 'L', priority: 1 }),
    inst('mid', { institution: 'M', priority: 5 }),
  ]);
  assert.deepEqual(
    first.schedule.map((s) => [s.id, s.slot]),
    [['low', 1], ['mid', 2]],
  );
  const second = house.schedule([inst('high', { institution: 'H', priority: 9 })]);
  return { house, first, second };
}

test('high priority preempts low priority with an atomic replayable certificate', () => {
  const { house, second } = buildPreemptedHouse();
  assert.deepEqual(
    second.schedule.map((s) => [s.id, s.slot]),
    [['high', 1], ['mid', 2]],
  );
  const preempt = second.certificates.find((c) => c.type === 'PREEMPT');
  assert.ok(preempt, 'a PREEMPT certificate is emitted');
  assert.equal(preempt.instruction.id, 'low');
  assert.equal(preempt.replay.op, 'REMOVE');
  assert.equal(preempt.replay.slot, 1);
  // The certificate is self-contained: pre-state snapshot + transition hashes.
  assert.equal(house.replayCertificate(preempt.id).ok, true);
  assert.equal(verifyCertificate(preempt).ok, true);
  // Tampering breaks verification.
  const tampered = { ...preempt, replay: { ...preempt.replay, instructionId: 'mid' } };
  assert.equal(verifyCertificate(tampered).ok, false);
});

test('undo of the preemptor incrementally restores the preempted instruction', () => {
  const { house, second } = buildPreemptedHouse();
  const high = second.schedule.find((s) => s.id === 'high');
  const undone = house.undo('high', high.confirmedAt);
  assert.deepEqual(undone.errors, []);
  assert.deepEqual(
    undone.schedule.map((s) => [s.id, s.slot]),
    [['low', 1], ['mid', 2]],
  );
  const types = undone.certificates.map((c) => c.type);
  assert.ok(types.includes('UNDO'));
  assert.ok(types.includes('RESTORE'));
  // Incremental repair never touched the unrelated confirmed instruction.
  const mid = undone.schedule.find((s) => s.id === 'mid');
  assert.equal(mid.slot, 2);
  assert.equal(mid.confirmedAt, 1);
  // Every certificate in the log replays cleanly.
  for (const cert of undone.certificates) {
    assert.equal(house.replayCertificate(cert.id).ok, true, `replay of ${cert.id}`);
  }
});

test('stale undo attempts are rejected with STALE_UNDO', () => {
  const { house, second } = buildPreemptedHouse();
  const high = second.schedule.find((s) => s.id === 'high');
  const wrongVersion = house.undo('high', high.confirmedAt + 100);
  assert.equal(wrongVersion.errors[0].code, 'STALE_UNDO');
  // State is untouched by the stale attempt.
  assert.equal(wrongVersion.schedule.length, 2);
  const ok = house.undo('high', high.confirmedAt);
  assert.deepEqual(ok.errors, []);
  const again = house.undo('high', high.confirmedAt);
  assert.equal(again.errors[0].code, 'STALE_UNDO');
  const missing = house.undo('never-existed');
  assert.equal(missing.errors[0].code, 'STALE_UNDO');
});

test('undo cascades to dependents as orphans and releases quota', () => {
  const house = new ClearingHouse({ slots: 3, capacity: 1, quotas: { Q: 3 } });
  const first = house.schedule([
    inst('root', { institution: 'Q', deadline: 1 }),
    inst('child', { institution: 'Q', deps: ['root'], deadline: 2 }),
    inst('grand', { institution: 'Q', deps: ['child'], deadline: 3 }),
  ]);
  assert.equal(first.schedule.length, 3);
  const root = first.schedule.find((s) => s.id === 'root');
  const undone = house.undo('root', root.confirmedAt);
  assert.deepEqual(undone.errors, []);
  assert.equal(undone.schedule.length, 0);
  assert.deepEqual(undone.orphans, ['child', 'grand']);
  const orphanCerts = undone.certificates.filter((c) => c.type === 'ORPHAN').map((c) => c.instruction.id);
  assert.deepEqual(orphanCerts.sort(), ['child', 'grand']);
  // Quota was released: a fresh instruction of the same institution fits.
  const refilled = house.schedule([inst('fresh', { institution: 'Q', deadline: 1 })]);
  assert.deepEqual(refilled.schedule.map((s) => s.id), ['fresh']);
});

test('orphans stay blocked while their dependency remains undone', () => {
  const house = new ClearingHouse({ slots: 2, capacity: 1 });
  const first = house.schedule([
    inst('root', { institution: 'R', deadline: 1 }),
    inst('leaf', { institution: 'L', deps: ['root'], deadline: 2 }),
  ]);
  assert.equal(first.schedule.length, 2);
  const root = first.schedule.find((s) => s.id === 'root');
  const undone = house.undo('root', root.confirmedAt);
  assert.deepEqual(undone.orphans, ['leaf']);
  // A new instruction can take the freed slot...
  const restored = house.schedule([inst('root2', { institution: 'R', deadline: 1 })]);
  assert.equal(restored.schedule.some((s) => s.id === 'root2'), true);
  // ...but leaf still depends on the undone 'root', so it stays orphaned.
  assert.deepEqual(restored.orphans, ['leaf']);
});
