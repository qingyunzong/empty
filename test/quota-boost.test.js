'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmpDir, cli, writeConfig, snapshotOf } = require('./helpers');
const { quotaProof } = require('../src/core');

function setup() {
  const dir = tmpDir();
  const config = {
    workers: [{ id: 'w1', throughput: 1, maxLevel: 2 }],
    quotas: { A: 20, B: 20 },
    periodLength: 100,
    boostThreshold: 3,
  };
  const cfgPath = writeConfig(dir, config);
  const init = cli(['init', '--dir', dir, '--config', cfgPath]);
  assert.equal(init.status, 0, init.stderr);
  return dir;
}

function submitPkg(dir, { id, tenant, size, deadline, lamport, prevHash = 'GENESIS' }) {
  const r = cli([
    'submit', '--dir', dir,
    '--id', id, '--tenant', tenant, '--submitter', `s-${id}`,
    '--size', String(size), '--level', '1', '--deadline', String(deadline),
    '--prev-hash', prevHash, '--evidence-hash', `ev-${id}`,
    '--client', `c-${id}`, '--lamport', String(lamport),
    '--quota-proof', quotaProof(tenant, tenant === 'A' ? 20 : 20),
  ]);
  assert.equal(r.status, 0, r.stderr);
  return r.json;
}

test('quota hog defers over-quota packages; waiting tenant is boosted', () => {
  const dir = setup();
  // Tenant A floods the period: A1+A2 fit in quota (12 <= 20), A3 does not (22 > 20).
  submitPkg(dir, { id: 'A1', tenant: 'A', size: 6, deadline: 6, lamport: 1 });
  submitPkg(dir, { id: 'A2', tenant: 'A', size: 6, deadline: 12, lamport: 2 });
  submitPkg(dir, { id: 'A3', tenant: 'A', size: 10, deadline: 50, lamport: 3 });
  // Tenant B: single package, same tight deadline as A1.
  submitPkg(dir, { id: 'B1', tenant: 'B', size: 6, deadline: 6, lamport: 4 });

  const v0 = cli(['verify', '--dir', dir, '--now', '0']);
  assert.equal(v0.status, 0, v0.stderr);
  // A3 exceeds tenant A's period quota -> deferred by quota.
  const quotaDeferred = v0.json.deferred.filter((d) => d.reason === 'quota').map((d) => d.pkg);
  assert.deepEqual(quotaDeferred, ['A3']);
  // Capacity is tight: B1 cannot finish on time and is left waiting.
  const verified0 = v0.json.results.filter((r) => r.status === 'verified').map((r) => r.pkg).sort();
  assert.deepEqual(verified0, ['A1', 'A2']);
  assert.ok(v0.json.deferred.some((d) => d.pkg === 'B1' && d.reason === 'unscheduled'));

  // Still waiting before the boost threshold.
  for (const t of [1, 2]) {
    const v = cli(['verify', '--dir', dir, '--now', String(t)]);
    assert.equal(v.status, 0, v.stderr);
    assert.equal(snapshotOf(dir).state.packages.B1.status, 'pending');
    assert.equal(snapshotOf(dir).state.packages.A3.status, 'pending', 'A3 still quota-blocked');
  }

  // After waiting >= boostThreshold, B1 is boosted: scheduled despite the
  // congestion created by tenant A, on a worker that satisfies its level.
  const v3 = cli(['verify', '--dir', dir, '--now', '3']);
  assert.equal(v3.status, 0, v3.stderr);
  const b1 = v3.json.schedule.find((s) => s.pkgId === 'B1');
  assert.ok(b1, 'boosted B1 must be scheduled');
  assert.equal(b1.workerId, 'w1');
  assert.equal(b1.start, 12, 'B1 starts after already-verified A1/A2 reservations');
  const snap = snapshotOf(dir).state;
  assert.equal(snap.packages.B1.status, 'verified');
  assert.ok(snap.packages.B1.cert, 'boosted package receives a certificate');
  // A3 waited past the threshold too: anti-starvation lifts it over the quota
  // as well, but it was quota-blocked until the boost kicked in.
  assert.equal(snap.packages.A3.status, 'verified');
});
