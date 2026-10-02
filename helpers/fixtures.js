'use strict';

// Base spec: two clerks with unrestricted submit/approve permissions.
function baseSpec() {
  return {
    threshold: 100,
    subjects: ['alice', 'bob', 'carol', 'dave'],
    roles: { clerk: [] },
    assignments: { alice: ['clerk'], bob: ['clerk'] },
    rules: [
      { id: 'allow-submit', effect: 'allow', role: 'clerk', action: 'submit' },
      { id: 'allow-approve', effect: 'allow', role: 'clerk', action: 'approve' },
    ],
    invariant: { role: 'clerk' },
  };
}

function denySelfRule() {
  return {
    id: 'deny-self-approve',
    effect: 'deny',
    role: 'clerk',
    action: 'approve',
    self: true,
  };
}

function denyBigRule() {
  return {
    id: 'deny-big-approve',
    effect: 'deny',
    role: 'clerk',
    action: 'approve',
    amountGt: 100,
  };
}

// Reduced spec for brute-force cross-checks (small enough to enumerate).
function reducedSpec() {
  return {
    threshold: 100,
    subjects: ['alice', 'bob'],
    amounts: [0, 101],
    maxLength: 4,
    roles: { clerk: [] },
    assignments: { alice: ['clerk'], bob: ['clerk'] },
    rules: [
      { id: 'allow-submit', effect: 'allow', role: 'clerk', action: 'submit' },
      { id: 'allow-approve', effect: 'allow', role: 'clerk', action: 'approve' },
    ],
    invariant: { role: 'clerk' },
  };
}

module.exports = { baseSpec, denySelfRule, denyBigRule, reducedSpec };
