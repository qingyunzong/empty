'use strict';

// Acceptance 3: modify_plan may only touch unlocked slots. Changes spanning
// already-dosed (locked) slots are partially rejected and listed; dosed slots
// get negative "compensate" records instead of deletion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const DOSES = [
  { pump_id: 'PAC-1', slot: 0, dose: 100 },
  { pump_id: 'PAC-1', slot: 1, dose: 120 },
  { pump_id: 'PAM-1', slot: 2, dose: 10 },
  { pump_id: 'PAM-1', slot: 3, dose: 20 },
];

// Runs exec but kills it after the effect of seq 1, so slots 0 and 1 are
// dosed (locked) and slots 2 and 3 are still pending (unlocked).
async function halfExecuted() {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  const crashed = await h.exec(dir, { DOSE_CRASH_AFTER: 'effect', DOSE_CRASH_SEQ: '1' });
  assert.equal(crashed.signal, 'SIGKILL');
  return dir;
}

test('acceptance 3: modify_plan partially rejects changes to dosed slots', async () => {
  const dir = await halfExecuted();

  const newPlan = path.join(dir, 'newplan.json');
  h.writeJson(newPlan, {
    doses: [
      { pump_id: 'PAC-1', slot: 0, dose: 40 },   // locked: reduce -> reject + compensate -60
      // slot 1 removed                              // locked: delete -> reject + compensate -120
      { pump_id: 'PAM-1', slot: 2, dose: 15 },   // unlocked: change applied
      { pump_id: 'PAM-1', slot: 3, dose: 20 },   // unlocked: unchanged
      { pump_id: 'PAC-1', slot: 4, dose: 50 },   // new slot: applied
    ],
  });

  const r = await h.runCli(['modify-plan', '--journal', path.join(dir, 'j'), '--plan', newPlan]);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'j', 'modify_result.json'), 'utf8'));

  // Rejections are listed with reasons.
  assert.equal(result.rejected.length, 2);
  const rej0 = result.rejected.find((x) => x.slot === 0);
  const rej1 = result.rejected.find((x) => x.slot === 1);
  assert.match(rej0.reason, /locked/);
  assert.equal(rej0.requested_dose, 40);
  assert.equal(rej0.recorded_dose, 100);
  assert.match(rej1.reason, /locked/);

  // Unlocked changes were applied.
  assert.ok(result.applied.some((a) => a.slot === 2 && a.change === 'set' && a.dose === 15));
  assert.ok(result.applied.some((a) => a.slot === 4 && a.change === 'set' && a.dose === 50));

  // Negative compensate records, no deletion of history.
  const comp = h.readLedger(dir).filter((e) => e.kind === 'compensate');
  assert.equal(comp.length, 2);
  assert.deepEqual(
    comp.map((c) => [c.key, c.dose]).sort(),
    [['PAC-1#0', -60], ['PAC-1#1', -120]],
  );
  const doses = h.readLedger(dir).filter((e) => e.kind === 'dose');
  assert.equal(doses.length, 2); // original dose records untouched

  // Recovery finishes the corrected plan: slots 2 (new dose 15), 3, 4 run.
  const rec = await h.recover(dir);
  assert.equal(rec.status, 0, rec.stderr);
  const t = h.totals(dir);
  assert.deepEqual(t.perSlot, {
    'PAC-1#0': 40,   // 100 dosed - 60 compensated
    'PAC-1#1': 0,    // 120 dosed - 120 compensated
    'PAM-1#2': 15,   // corrected before execution
    'PAM-1#3': 20,
    'PAC-1#4': 50,
  });
  assert.equal(t.total, 125);
});

test('modify-plan rejects the whole request on invalid new plan (exit 2)', async () => {
  const dir = await halfExecuted();
  const bad = path.join(dir, 'bad.json');
  h.writeJson(bad, { doses: [{ pump_id: 'GHOST', slot: 9, dose: 5 }] });
  const r = await h.runCli(['modify-plan', '--journal', path.join(dir, 'j'), '--plan', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown pump: GHOST/);
});

test('compensate command writes a negative record for a dosed slot', async () => {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  assert.equal((await h.exec(dir)).status, 0);

  const r = await h.runCli(
    ['compensate', '--journal', path.join(dir, 'j'), '--pump', 'PAC-1', '--slot', '0'],
  );
  assert.equal(r.status, 0, r.stderr);
  const t = h.totals(dir);
  assert.equal(t.perSlot['PAC-1#0'], 0);
  assert.equal(t.total, 150); // 120 + 10 + 20 remain

  // A positive "compensation" is a validation error (exit 2).
  const bad = await h.runCli(
    ['compensate', '--journal', path.join(dir, 'j'), '--pump', 'PAC-1', '--slot', '1', '--dose', '5'],
  );
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must be negative/);
});
