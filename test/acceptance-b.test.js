import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.js';
import { makePolicy } from './support/helpers.js';

const BASE = {
  roles: { anyone: {}, operator: { inherits: ['anyone'] } },
  zones: { plant: {}, cellA: { inherits: ['plant'] } },
  subjects: { alice: { roles: ['operator'] } },
  devices: { press1: { zone: 'cellA' } },
  rules: [
    { id: 'r-open', effect: 'allow', action: 'openMold', role: 'operator', zone: 'cellA' },
    { id: 'r-estop', effect: 'allow', action: 'emergencyStop', role: 'operator', zone: 'cellA' },
  ],
};

const T1 = '2026-01-01T09:00:00Z';
const T2 = '2026-02-01T09:00:00Z';
const T3 = '2026-03-01T09:00:00Z';

function req(id, action, time) {
  return { id, subject: 'alice', device: 'press1', action, time };
}

test('B: normal revokeAt only affects requests at/after the effective point', () => {
  const v1 = makePolicy(BASE);
  const v2 = makePolicy({
    ...BASE,
    rules: BASE.rules.map((r) => (r.id === 'r-open'
      ? { ...r, revokeAt: '2026-02-01T00:00:00Z' }
      : r)),
  });

  const requests = [req('b1', 'openMold', T1), req('b2', 'openMold', T2), req('b3', 'openMold', T3)];
  const before = requests.map((q) => evaluate(v1, q));
  const after = requests.map((q) => evaluate(v2, q));

  assert.deepEqual(before.map((r) => r.decision), ['allow', 'allow', 'allow']);

  // history before the revocation point replays identically
  assert.equal(after[0].decision, before[0].decision);
  assert.deepEqual(after[0].winners, before[0].winners);
  assert.equal(after[0].decision, 'allow');

  // requests at/after revokeAt lose the rule
  assert.equal(after[1].decision, 'deny');
  assert.equal(after[1].reason, 'no-applicable-rule');
  assert.equal(after[2].decision, 'deny');
});

test('B: emergency-stop revocation is retroactive and kills dependent authorizations', () => {
  const v1 = makePolicy(BASE);
  const v2 = makePolicy({
    ...BASE,
    rules: BASE.rules.map((r) => (r.id === 'r-estop'
      ? { ...r, revokeAt: '2026-03-01T00:00:00Z' } // after the request time, still retroactive
      : r)),
  });

  const q = req('e1', 'emergencyStop', T1);
  const granted = evaluate(v1, q);
  assert.equal(granted.decision, 'allow');
  assert.deepEqual(granted.winners, ['r-estop']);

  const replayed = evaluate(v2, q);
  assert.equal(replayed.decision, 'deny');
  assert.equal(replayed.reason, 'retroactive-revocation');
  assert.deepEqual(replayed.retroactiveRevocations, ['r-estop']);
  assert.ok(replayed.overridden.some((o) => o.rule === 'r-estop' && o.why === 'retroactive-revoked'));

  // the non-emergency rule is untouched by the emergency revocation
  const other = evaluate(v2, req('e2', 'openMold', T1));
  assert.equal(other.decision, 'allow');
});
