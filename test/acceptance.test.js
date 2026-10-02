'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dose-test-'));
}

function writeFixture(dir, doses) {
  fs.writeFileSync(
    path.join(dir, 'pumps.json'),
    JSON.stringify({ pumps: [{ pump_id: 'p1' }, { pump_id: 'p2' }] })
  );
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ doses }));
}

function plan8() {
  const doses = [];
  for (let i = 0; i < 8; i++) {
    doses.push({ pump_id: i % 2 === 0 ? 'p1' : 'p2', slot: `s${i}`, dose: (i + 1) * 10 });
  }
  return doses;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function readLedger(journalDir) {
  const file = path.join(journalDir, 'dose_ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function totalDose(ledger) {
  return ledger.reduce((s, e) => s + e.dose, 0);
}

// ---------- Acceptance 1: kill at both fault points, recovery matches reference ----------

test('acceptance 1: crash at intent/effect fault points recovers to reference total', () => {
  // reference: no fault
  const refDir = makeWorkdir();
  writeFixture(refDir, plan8());
  const ref = runCli(['exec', '--plan', path.join(refDir, 'plan.json'), '--journal', path.join(refDir, 'j'), '--out', path.join(refDir, 'out')]);
  assert.equal(ref.status, 0, ref.stderr);
  const refLedger = readLedger(path.join(refDir, 'j'));
  const refTotal = totalDose(refLedger);
  assert.equal(refTotal, 360);

  for (const point of ['intent', 'effect']) {
    const dir = makeWorkdir();
    writeFixture(dir, plan8());
    const j = path.join(dir, 'j');
    // kill the process mid-step 3 at the given fault point
    const crashed = runCli(
      ['exec', '--plan', path.join(dir, 'plan.json'), '--journal', j, '--out', path.join(dir, 'out')],
      { DOSE_CRASH_AT: `3:${point}` }
    );
    assert.equal(crashed.signal, 'SIGKILL', `expected SIGKILL at ${point}, got ${crashed.status}`);

    const rec = runCli(['recover', '--journal', j]);
    assert.equal(rec.status, 0, rec.stderr);
    const recovered = JSON.parse(fs.readFileSync(path.join(j, 'recovered.json'), 'utf8'));
    if (point === 'intent') {
      assert.deepEqual(recovered.replayed, ['p2::s3']);
      assert.deepEqual(recovered.checkpoint_completed, []);
    } else {
      assert.deepEqual(recovered.replayed, []);
      assert.deepEqual(recovered.checkpoint_completed, ['p2::s3']);
    }

    // finish remaining steps
    const done = runCli(['exec', '--plan', path.join(dir, 'plan.json'), '--journal', j, '--out', path.join(dir, 'out')]);
    assert.equal(done.status, 0, done.stderr);

    const ledger = readLedger(j);
    assert.equal(totalDose(ledger), refTotal, `total dose mismatch after crash at ${point}`);
    assert.deepEqual(
      ledger.map((e) => [e.key, e.dose]),
      refLedger.map((e) => [e.key, e.dose]),
      `ledger content mismatch after crash at ${point}`
    );
    // exported ledger matches journal ledger
    const outLedger = fs.readFileSync(path.join(dir, 'out', 'dose_ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(outLedger, ledger);
  }
});

// ---------- Acceptance 2: resubmitting the same slot does not accumulate ----------

test('acceptance 2: re-executing the same plan does not double-dose', () => {
  const dir = makeWorkdir();
  writeFixture(dir, plan8());
  const j = path.join(dir, 'j');
  const args = ['exec', '--plan', path.join(dir, 'plan.json'), '--journal', j, '--out', path.join(dir, 'out')];

  assert.equal(runCli(args).status, 0);
  const before = readLedger(j);
  assert.equal(runCli(args).status, 0);
  assert.equal(runCli(args).status, 0);
  const after = readLedger(j);

  assert.equal(after.length, 8);
  assert.deepEqual(after, before);
  assert.equal(totalDose(after), 360);
});

// ---------- Acceptance 3: modify_plan partially rejects locked slots; compensate ----------

test('acceptance 3: modify_plan rejects dosed slots, applies unlocked, compensate adds negative record', () => {
  const dir = makeWorkdir();
  writeFixture(dir, plan8());
  const j = path.join(dir, 'j');
  const plan = path.join(dir, 'plan.json');

  // crash after step 2's effect -> steps 0..2 dosed after recovery, 3..7 untouched
  const crashed = runCli(['exec', '--plan', plan, '--journal', j], { DOSE_CRASH_AT: '2:effect' });
  assert.equal(crashed.signal, 'SIGKILL');
  assert.equal(runCli(['recover', '--journal', j]).status, 0);
  assert.equal(totalDose(readLedger(j)), 60); // 10+20+30

  // new plan: change dosed slot s1 (rejected), remove dosed slot s2 (rejected),
  // change unlocked s5 (applied), drop unlocked s6/s7 (applied)
  const newDoses = plan8().filter((d) => !['s2', 's6', 's7'].includes(d.slot)).map((d) => {
    if (d.slot === 's1') return { ...d, dose: 999 };
    if (d.slot === 's5') return { ...d, dose: 66 };
    return d;
  });
  const newPlan = path.join(dir, 'newplan.json');
  fs.writeFileSync(newPlan, JSON.stringify({ doses: newDoses }));

  const mod = runCli(['modify-plan', '--journal', j, '--plan', newPlan]);
  assert.equal(mod.status, 0, mod.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(j, 'modify_plan_result.json'), 'utf8'));
  assert.ok(result.applied.length > 0 && result.rejected.length > 0, 'expected partial application');
  const rejectedSlots = result.rejected.map((r) => r.slot).sort();
  assert.deepEqual(rejectedSlots, ['s1', 's2']);
  assert.ok(result.rejected.every((r) => r.reason === 'slot_locked_already_dosed'));
  const appliedOps = result.applied.map((a) => `${a.op}:${a.slot}`).sort();
  assert.deepEqual(appliedOps, ['change:s5', 'remove:s6', 'remove:s7']);

  // compensate the dosed slot s1 instead of deleting it
  const comp = runCli(['compensate', '--journal', j, '--pump', 'p2', '--slot', 's1', '--dose', '20']);
  assert.equal(comp.status, 0, comp.stderr);
  const ledgerAfterComp = readLedger(j);
  const entry = ledgerAfterComp[ledgerAfterComp.length - 1];
  assert.equal(entry.type, 'compensate');
  assert.equal(entry.dose, -20);

  const ledger = ledgerAfterComp;
  assert.equal(totalDose(ledger), 40); // 60 - 20
  assert.ok(ledger.some((e) => e.type === 'compensate' && e.dose === -20));
  // original dose record for s1 is still present (not deleted)
  assert.ok(ledger.some((e) => e.type === 'dose' && e.key === 'p2::s1' && e.dose === 20));
});

// ---------- Acceptance 4: enumerate 8 slots x 2 fault points, compare against reference ----------

test('acceptance 4: 8-slot crash enumeration converges to reference ledger', () => {
  const refDir = makeWorkdir();
  writeFixture(refDir, plan8());
  assert.equal(runCli(['exec', '--plan', path.join(refDir, 'plan.json'), '--journal', path.join(refDir, 'j')]).status, 0);
  const refLedger = readLedger(path.join(refDir, 'j')).map((e) => [e.key, e.dose]);

  for (let step = 0; step < 8; step++) {
    for (const point of ['intent', 'effect']) {
      const dir = makeWorkdir();
      writeFixture(dir, plan8());
      const j = path.join(dir, 'j');
      const crashed = runCli(
        ['exec', '--plan', path.join(dir, 'plan.json'), '--journal', j],
        { DOSE_CRASH_AT: `${step}:${point}` }
      );
      assert.equal(crashed.signal, 'SIGKILL', `step ${step} ${point}`);
      assert.equal(runCli(['recover', '--journal', j]).status, 0, `recover step ${step} ${point}`);
      assert.equal(
        runCli(['exec', '--plan', path.join(dir, 'plan.json'), '--journal', j]).status,
        0,
        `resume step ${step} ${point}`
      );
      const ledger = readLedger(j).map((e) => [e.key, e.dose]);
      assert.deepEqual(ledger, refLedger, `ledger mismatch for crash at step ${step} ${point}`);
      assert.equal(totalDose(readLedger(j)), 360);
    }
  }
});

// ---------- Validation errors: exit code 2 ----------

test('validation: unknown pump, negative dose, slot overlap all exit with code 2', () => {
  const cases = [
    { name: 'unknown pump', doses: [{ pump_id: 'nope', slot: 's0', dose: 5 }], code: 'UNKNOWN_PUMP' },
    { name: 'negative dose', doses: [{ pump_id: 'p1', slot: 's0', dose: -5 }], code: 'NEGATIVE_DOSE' },
    {
      name: 'slot overlap (duplicate slot)',
      doses: [
        { pump_id: 'p1', slot: 's0', dose: 5 },
        { pump_id: 'p1', slot: 's0', dose: 6 },
      ],
      code: 'SLOT_OVERLAP',
    },
    {
      name: 'slot overlap (interval)',
      doses: [
        { pump_id: 'p1', slot: { start: 0, end: 10 }, dose: 5 },
        { pump_id: 'p1', slot: { start: 5, end: 15 }, dose: 6 },
      ],
      code: 'SLOT_OVERLAP',
    },
  ];
  for (const c of cases) {
    const dir = makeWorkdir();
    writeFixture(dir, c.doses);
    const res = runCli(['exec', '--plan', path.join(dir, 'plan.json'), '--journal', path.join(dir, 'j')]);
    assert.equal(res.status, 2, `${c.name}: expected exit 2, got ${res.status} (${res.stderr})`);
  }
});
