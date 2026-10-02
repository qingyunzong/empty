import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {ok, tempStateDir, writeJson} from './helpers.js';

const scenario = {
  stations: [
    {
      id: 'SF', link: 'LF', battery: 10,
      windows: [
        {id: 'SFw1', start: 0, end: 2, cost: 1, locked: true},
        {id: 'SFw2', start: 2, end: 4, cost: 1},
        {id: 'SFw3', start: 4, end: 6, cost: 1},
        {id: 'SFw4', start: 6, end: 8, cost: 1},
      ],
    },
    {
      id: 'SG', link: 'LG', battery: 10,
      windows: [{id: 'SGw1', start: 0, end: 2, cost: 1}],
    },
  ],
  contracts: [
    {id: 'CF', station: 'SF', min: 2, floor: 1, period: 10, quota: 4},
    {id: 'CG', station: 'SG', min: 1, floor: 0, period: 10, quota: 1},
  ],
};

function runSequence(dir, crash) {
  const sc = writeJson(dir, 'scenario.json', scenario);
  const ingested = ok(['ingest', sc, '--state', dir]);
  assert.equal(ingested.plan.served.CF, 2);

  const failed = ok(['fail', '--station', 'SF', '--from', '1', '--to', '5', '--state', dir]);
  assert.equal(failed.failure.id, 'F2');
  // Locked window SFw1 cannot be preempted; SFw2 is revoked with a token.
  assert.deepEqual(failed.failure.unpreemptable, ['SFw1']);
  assert.equal(failed.failure.revocations.length, 1);
  assert.ok(failed.failure.revocations[0].startsWith('rvk_'));

  if (crash) rmSync(join(dir, 'state.json'));

  const restored = ok(['restore', '--failure', 'F2', '--state', dir]);
  return {ingested, failed, restored};
}

test('acceptance 4: restore proves outside-interval history unchanged', () => {
  const dir = tempStateDir();
  const {restored} = runSequence(dir, false);
  const cert = restored.certificate;
  assert.equal(cert.unchanged, true);
  assert.equal(cert.outsideRootBefore, cert.outsideRootAfter);
  assert.equal(restored.recovered, false);
});

test('acceptance 4: restore after crash replays the event log consistently', () => {
  const dirA = tempStateDir();
  const dirB = tempStateDir();
  const a = runSequence(dirA, false);
  const b = runSequence(dirB, true);
  assert.equal(b.restored.recovered, true, 'crash must be detected and replayed');
  // Plan after restore is identical whether or not a crash happened.
  const planA = ok(['plan', '--state', dirA]).plan;
  const planB = ok(['plan', '--state', dirB]).plan;
  assert.deepEqual(planB, planA);
  // And it matches the pre-failure plan (failure interval fully re-planned).
  assert.deepEqual(planA.entries, a.ingested.plan.entries);
  assert.equal(planA.merkle.root, a.ingested.plan.merkle.root);
});
