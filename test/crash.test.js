'use strict';

// Acceptance 1 & 4: kill the process at both fault points (after intent /
// after effect) for every one of the 8 plan steps, recover, and verify the
// resulting ledger matches the no-fault reference exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const SLOTS = 8;
const DOSES = Array.from({ length: SLOTS }, (_, i) => ({
  pump_id: i % 2 === 0 ? 'PAC-1' : 'PAM-1',
  slot: i,
  dose: 10 * (i + 1),
}));

function reference() {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  return h.exec(dir).then((r) => {
    assert.equal(r.status, 0, r.stderr);
    return { total: h.totals(dir).total, perSlot: h.totals(dir).perSlot, ledger: h.readLedger(dir) };
  });
}

test('acceptance 1+4: 8-slot plan, enumerate crash points, recovery matches reference', async (t) => {
  const ref = await reference();
  assert.equal(ref.total, (SLOTS * (SLOTS + 1) / 2) * 10);
  assert.equal(ref.ledger.length, SLOTS);

  for (const point of ['intent', 'effect']) {
    for (let seq = 0; seq < SLOTS; seq += 1) {
      await t.test(`crash after ${point} at seq ${seq}`, async () => {
        const dir = h.tmpdir();
        h.setup(dir, DOSES);

        const crashed = await h.exec(dir, {
          DOSE_CRASH_AFTER: point,
          DOSE_CRASH_SEQ: String(seq),
        });
        assert.equal(crashed.signal, 'SIGKILL', `expected SIGKILL, got ${JSON.stringify(crashed)}`);

        const recovered = await h.recover(dir);
        assert.equal(recovered.status, 0, recovered.stderr);

        // Totals and per-slot doses match the no-fault reference.
        const t2 = h.totals(dir);
        assert.equal(t2.total, ref.total);
        assert.deepEqual(t2.perSlot, ref.perSlot);

        // Exactly one dose record per idempotency key: no double dosing.
        const doses = h.readLedger(dir).filter((e) => e.kind === 'dose');
        assert.equal(doses.length, SLOTS);
        assert.equal(new Set(doses.map((e) => e.key)).size, SLOTS);

        // recovered.json classifies the interrupted step correctly.
        const rec = JSON.parse(fs.readFileSync(path.join(dir, 'j', 'recovered.json'), 'utf8'));
        if (point === 'intent') {
          assert.deepEqual(rec.replayed, [seq]);
          assert.deepEqual(rec.checkpoint_only, []);
        } else {
          assert.deepEqual(rec.replayed, []);
          assert.deepEqual(rec.checkpoint_only, [seq]);
        }
        assert.deepEqual(rec.executed, Array.from({ length: SLOTS - seq - 1 }, (_, i) => seq + 1 + i));
      });
    }
  }
});

test('acceptance 1: crash during recovery itself is also recoverable', async () => {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  const ref = await reference();

  // Crash the exec at seq 3 (after intent), then crash the recovery while
  // replaying that same step (after intent again), then recover once more.
  const c1 = await h.exec(dir, { DOSE_CRASH_AFTER: 'intent', DOSE_CRASH_SEQ: '3' });
  assert.equal(c1.signal, 'SIGKILL');
  const c2 = await h.recover(dir, { DOSE_CRASH_AFTER: 'intent', DOSE_CRASH_SEQ: '3' });
  assert.equal(c2.signal, 'SIGKILL');
  const ok = await h.recover(dir);
  assert.equal(ok.status, 0, ok.stderr);

  const t2 = h.totals(dir);
  assert.equal(t2.total, ref.total);
  assert.deepEqual(t2.perSlot, ref.perSlot);
  const doses = h.readLedger(dir).filter((e) => e.kind === 'dose');
  assert.equal(doses.length, SLOTS);
});
