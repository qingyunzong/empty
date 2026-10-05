'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/simulator');
const { ProtocolError } = require('../src/errors');

// Acceptance 4: enumerate small command sequences and compare the simulator's
// budget state against an independent brute-force reference model.

// Reference: plain sequential semantics, no transactions, no protocol.
function reference(ops, cap) {
  const jobs = new Map();
  let used = 0;
  for (let i = 0; i < ops.length; i++) {
    const c = ops[i];
    if (c.op === 'PLAN') {
      if (jobs.has(c.id)) return { error: 'protocol', index: i, used, jobs };
      if (used + c.cost > cap) return { error: 'budget', index: i, used, jobs };
      jobs.set(c.id, { cost: c.cost, start: c.start });
      used += c.cost;
    } else if (c.op === 'MOVE') {
      const j = jobs.get(c.id);
      if (!j) return { error: 'protocol', index: i, used, jobs };
      if (used - j.cost + c.cost > cap) return { error: 'budget', index: i, used, jobs };
      used += c.cost - j.cost;
      jobs.set(c.id, { cost: c.cost, start: c.start });
    } else if (c.op === 'CANCEL') {
      const j = jobs.get(c.id);
      if (!j) return { error: 'protocol', index: i, used, jobs };
      used -= j.cost;
      jobs.delete(c.id);
    } else {
      throw new Error(`bad template ${c.op}`);
    }
  }
  return { error: null, used, jobs };
}

// Action templates; ver is assigned per id at materialization time.
const TEMPLATES = [
  (v) => ({ op: 'PLAN', id: 'A', ver: v('A'), cost: 10, start: 0 }),
  (v) => ({ op: 'PLAN', id: 'B', ver: v('B'), cost: 20, start: 1 }),
  (v) => ({ op: 'MOVE', id: 'A', ver: v('A'), cost: 20, start: 2 }),
  (v) => ({ op: 'MOVE', id: 'B', ver: v('B'), cost: 10, start: 0 }),
  (v) => ({ op: 'CANCEL', id: 'A', ver: v('A') }),
  (v) => ({ op: 'CANCEL', id: 'B', ver: v('B') }),
];

function materialize(indices) {
  const vers = new Map();
  const nextVer = (id) => {
    const v = (vers.get(id) ?? 0) + 1;
    vers.set(id, v);
    return v;
  };
  return indices.map((i) => TEMPLATES[i](nextVer));
}

function* sequences(maxLen) {
  const n = TEMPLATES.length;
  for (let len = 1; len <= maxLen; len++) {
    const idx = new Array(len).fill(0);
    for (;;) {
      yield idx.slice();
      let p = len - 1;
      while (p >= 0 && ++idx[p] === n) idx[p--] = 0;
      if (p < 0) break;
    }
  }
}

function jobsOf(report) {
  return new Map(report.plan.map((j) => [j.id, { cost: j.cost, start: j.start }]));
}

test('exhaustive small sequences match brute-force budget state', () => {
  const CAP = 30;
  let checked = 0;
  const tally = { ok: 0, budget: 0, protocol: 0 };

  for (const indices of sequences(4)) {
    const ops = materialize(indices);
    const ref = reference(ops, CAP);
    const refJobs = new Map(
      [...ref.jobs.entries()].map(([k, v]) => [k, { cost: v.cost, start: v.start }])
    );

    if (ref.error === 'protocol') {
      let thrown = null;
      try {
        run(ops, { cap: CAP });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof ProtocolError, `seq ${indices} should raise ProtocolError`);
      assert.equal(thrown.report.used, ref.used, `seq ${indices} used`);
      assert.deepEqual(jobsOf(thrown.report), refJobs, `seq ${indices} jobs`);
      tally.protocol++;
    } else {
      const report = run(ops, { cap: CAP });
      if (ref.error === 'budget') {
        assert.equal(report.ok, false, `seq ${indices} should fail on budget`);
        assert.equal(report.failure.type, 'budget');
        tally.budget++;
      } else {
        assert.equal(report.ok, true, `seq ${indices} should succeed`);
        tally.ok++;
      }
      assert.equal(report.used, ref.used, `seq ${indices} used`);
      assert.deepEqual(jobsOf(report), refJobs, `seq ${indices} jobs`);
    }
    checked++;
  }

  assert.equal(checked, 6 + 36 + 216 + 1296);
  assert.ok(tally.ok > 0 && tally.budget > 0 && tally.protocol > 0);
});
