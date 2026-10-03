'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpDir, writeJson, runCliJson } = require('./helper');

// A and B share downlink L1; C is remote on L2. Closing one of A's windows
// must re-plan only the L1 closure and leave C's plan hash bit-identical.
const scenario = {
  name: 'incremental-demo',
  stations: [
    {
      id: 'A',
      link: 'L1',
      battery: 3,
      windows: [
        { id: 'a1', start: 0, end: 2, energy: 1 },
        { id: 'a2', start: 2, end: 4, energy: 1 },
        { id: 'a3', start: 4, end: 6, energy: 1 },
      ],
    },
    {
      id: 'B',
      link: 'L1',
      battery: 2,
      windows: [
        { id: 'b1', start: 1, end: 3, energy: 1 },
        { id: 'b2', start: 3, end: 5, energy: 1 },
      ],
    },
    {
      id: 'C',
      link: 'L2',
      battery: 2,
      windows: [
        { id: 'c1', start: 0, end: 2, energy: 1 },
        { id: 'c2', start: 2, end: 4, energy: 1 },
      ],
    },
  ],
  contracts: [
    { id: 'CA', station: 'A', min: 1 },
    { id: 'CB', station: 'B', min: 1 },
    { id: 'CC', station: 'C', min: 2 },
  ],
};

test('acceptance 3: closing a window re-plans locally, remote hash unchanged', () => {
  const dir = tmpDir();
  const state = `${dir}/state`;
  const scenarioFile = writeJson(dir, 'scenario.json', scenario);
  runCliJson(['ingest', scenarioFile, '--state', state]);
  const before = runCliJson(['plan', '--state', state]);

  const aWindows = before.schedule.A.map((w) => w.window);
  assert.ok(aWindows.includes('a1'), `expected a1 scheduled, got ${aWindows}`);

  const correctionFile = writeJson(dir, 'correction.json', {
    stations: { A: { closeWindows: ['a1'] } },
  });
  const out = runCliJson(['correct', correctionFile, '--state', state]);

  assert.deepEqual(out.affected, ['A', 'B'], 'only the L1 closure is affected');
  assert.deepEqual(out.unchanged, ['C']);
  assert.ok(out.replanned.includes('A'));
  assert.equal(
    out.plan.stationHashes.C,
    before.stationHashes.C,
    'remote station C plan hash must be unchanged'
  );
  assert.deepEqual(out.plan.schedule.C, before.schedule.C);
  assert.ok(
    !out.plan.schedule.A.some((w) => w.window === 'a1'),
    'closed window must be gone from the plan'
  );
  assert.equal(out.plan.unmet.length, 0, 'all contracts still satisfied after local rearrange');
});

test('correction is rejected when it breaks locked-window mutex (exit 6)', () => {
  const dir = tmpDir();
  const state = `${dir}/state`;
  const scenarioFile = writeJson(dir, 'scenario.json', scenario);
  runCliJson(['ingest', scenarioFile, '--state', state]);
  const bad = writeJson(dir, 'bad.json', {
    stations: { B: { addWindows: [{ id: 'b9', start: 0, end: 2, energy: 1, locked: true }] } },
  });
  // a1 is not locked, so first lock a1 via a fresh scenario instead
  const lockedScenario = JSON.parse(JSON.stringify(scenario));
  lockedScenario.stations[0].windows[0].locked = true;
  const lockedFile = writeJson(dir, 'locked.json', lockedScenario);
  runCliJson(['ingest', lockedFile, '--state', state]);
  const res = runCliJsonSafe(['correct', bad, '--state', state]);
  assert.equal(res.code, 6);
  assert.match(res.stderr, /mutex overlap/);
});

function runCliJsonSafe(argv) {
  const { runCli } = require('./helper');
  return runCli(argv);
}
