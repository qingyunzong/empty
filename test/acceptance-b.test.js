'use strict';

// Acceptance B: replaying history after revocation stays consistent with the
// revocation semantics (normal = from revokeAt on, retroactive = reaches back)
// and is deterministic across replays.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicies, evaluateRequest } = require('../src/index');

const RAW = {
  roles: { worker: {}, operator: { inherits: ['worker'] } },
  zones: { hall: {}, cell: { inherits: ['hall'] } },
  subjects: { alice: { roles: ['operator'] } },
  devices: { press: { zone: 'cell' } },
  rules: [
    {
      id: 'normal-allow',
      action: 'open_mold',
      effect: 'allow',
      role: 'operator',
      zone: 'cell',
      revokeAt: '2026-09-15T00:00:00Z',
    },
    {
      id: 'retro-allow',
      action: 'reset_estop',
      effect: 'allow',
      role: 'operator',
      retroactive: true,
      revokeAt: '2026-09-15T00:00:00Z',
    },
  ],
};

const HISTORY = [
  { id: 'h1', subject: 'alice', device: 'press', action: 'open_mold', time: '2026-09-10T10:00:00Z' },
  { id: 'h2', subject: 'alice', device: 'press', action: 'open_mold', time: '2026-09-20T10:00:00Z' },
  { id: 'h3', subject: 'alice', device: 'press', action: 'reset_estop', time: '2026-09-10T10:00:00Z' },
  { id: 'h4', subject: 'alice', device: 'press', action: 'reset_estop', time: '2026-09-20T10:00:00Z' },
];

function withoutRevocations(raw) {
  const clone = structuredClone(raw);
  for (const r of clone.rules) {
    r.revokeAt = null;
    r.retroactive = false;
  }
  return clone;
}

function replay(rawPolicies) {
  const policies = loadPolicies(rawPolicies);
  return HISTORY.map((r) => evaluateRequest(policies, r, { withCounterexample: false }));
}

test('B: baseline history (before any revocation) allows everything', () => {
  const baseline = replay(withoutRevocations(RAW));
  assert.deepEqual(baseline.map((d) => d.decision), ['allow', 'allow', 'allow', 'allow']);
});

test('B: replay after revocation is consistent with revocation semantics', () => {
  const after = replay(RAW);
  const byId = Object.fromEntries(after.map((d) => [d.requestId, d]));
  // Normal revocation: requests before revokeAt keep their authorization...
  assert.equal(byId.h1.decision, 'allow');
  assert.equal(byId.h1.rulePath[0].ruleId, 'normal-allow');
  // ...requests at/after revokeAt lose it.
  assert.equal(byId.h2.decision, 'deny');
  assert.equal(byId.h2.reason, 'no_matching_rule');
  // Retroactive e-stop revocation reaches back: even pre-revokeAt history flips.
  assert.equal(byId.h3.decision, 'deny');
  assert.deepEqual(byId.h3.retroactivelyRevoked, ['retro-allow']);
  assert.equal(byId.h4.decision, 'deny');
});

test('B: replaying the same history twice yields identical decisions', () => {
  const first = replay(RAW);
  const second = replay(RAW);
  assert.deepEqual(first, second);
});

test('B: only revocation-dependent decisions change between the two replays', () => {
  const baseline = replay(withoutRevocations(RAW));
  const after = replay(RAW);
  const changed = after.filter((d, i) => d.decision !== baseline[i].decision).map((d) => d.requestId);
  assert.deepEqual(changed.sort(), ['h2', 'h3', 'h4']);
  // h1 predates the normal revocation point and is not retroactive: unchanged.
  assert.equal(after[0].decision, baseline[0].decision);
});
