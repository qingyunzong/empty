'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpec } = require('../spec');
const { findCounterexample } = require('../search');
const { bruteForce } = require('../brute');
const { reducedSpec, denySelfRule } = require('../helpers/fixtures');

// Acceptance 4: the directed search is cross-checked item by item against an
// independent brute-force enumerator on reduced-but-nontrivial specs.
function crossCheck(name, raw) {
  test(`cross-check vs brute force: ${name}`, () => {
    const spec = parseSpec(raw);
    const directed = findCounterexample(spec);
    const brute = bruteForce(spec);
    if (brute === null) {
      assert.equal(directed, null);
      return;
    }
    assert.notEqual(directed, null);
    assert.equal(directed.length, brute.length);
    assert.deepEqual(directed.sequence, brute.sequence);
    assert.deepEqual(directed.violation, brute.violation);
  });
}

crossCheck('plain allows, 2 subjects x 2 amounts x length 4', reducedSpec());

crossCheck('deny self-approval eliminates every witness', (() => {
  const raw = reducedSpec();
  raw.rules.push(denySelfRule());
  return raw;
})());

crossCheck('revocation at position 2 keeps the length-2 witness', (() => {
  const raw = reducedSpec();
  raw.revocations = [{ rule: 'allow-approve', at: 2 }];
  return raw;
})());

crossCheck('revocation at position 1 removes every witness', (() => {
  const raw = reducedSpec();
  raw.revocations = [{ rule: 'allow-approve', at: 1 }];
  return raw;
})());

crossCheck('role inheritance with per-role deny, 3 subjects x 3 amounts', {
  threshold: 100,
  subjects: ['alice', 'bob', 'carol'],
  amounts: [0, 100, 101],
  maxLength: 3,
  roles: { employee: [], clerk: ['employee'], restricted: [] },
  assignments: { alice: ['clerk', 'restricted'], bob: ['employee'], carol: ['clerk'] },
  rules: [
    { id: 'allow-submit', effect: 'allow', role: 'employee', action: 'submit' },
    { id: 'allow-approve', effect: 'allow', role: 'employee', action: 'approve' },
    { id: 'deny-restricted', effect: 'deny', role: 'restricted', action: 'approve', self: true },
  ],
  invariant: { role: 'clerk' },
});

crossCheck('deny over-threshold approvals only', (() => {
  const raw = reducedSpec();
  raw.rules.push({
    id: 'deny-big',
    effect: 'deny',
    role: 'clerk',
    action: 'approve',
    amountGt: 100,
  });
  return raw;
})());
