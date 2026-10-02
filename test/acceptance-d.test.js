'use strict';

// Acceptance D: for n <= 8 rules, enumerate the full truth table
// (each rule: applicable-allow / applicable-deny / not-applicable) and
// cross-check the interpreter against an independent reference implementation
// of the documented semantics:
//   - no applicable rule            -> deny (interlock safe default)
//   - applicable rules, any deny    -> deny (same-level conflict defaults to deny)
//   - applicable rules, all allow   -> allow

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicies, evaluateInternal } = require('../src/index');

const ALLOW = 0;
const DENY = 1;
const OFF = 2;

function referenceDecision(states) {
  const applicable = states.filter((s) => s !== OFF);
  if (applicable.length === 0) return 'deny';
  return applicable.includes(DENY) ? 'deny' : 'allow';
}

function buildPolicies(states) {
  const rules = states.map((state, i) => {
    const rule = { id: `r${i}`, action: 'open_mold', effect: state === DENY ? 'deny' : 'allow' };
    // OFF rules target a role the subject does not have -> not applicable.
    rule.role = state === OFF ? 'ghost' : 'worker';
    return rule;
  });
  return loadPolicies({
    roles: { worker: {}, ghost: {} },
    zones: { hall: {} },
    subjects: { alice: { roles: ['worker'] } },
    devices: { press: { zone: 'hall' } },
    rules,
  });
}

const REQUEST = { id: 't', subject: 'alice', device: 'press', action: 'open_mold', time: '2026-10-01T00:00:00Z' };

function* enumerate(n) {
  const total = 3 ** n;
  for (let code = 0; code < total; code++) {
    const states = [];
    let x = code;
    for (let i = 0; i < n; i++) {
      states.push(x % 3);
      x = Math.floor(x / 3);
    }
    yield states;
  }
}

test('D: truth table for n = 1..8 rules matches the reference semantics', () => {
  let cases = 0;
  for (let n = 1; n <= 8; n++) {
    for (const states of enumerate(n)) {
      const policies = buildPolicies(states);
      const { record } = evaluateInternal(policies, REQUEST);
      const expected = referenceDecision(states);
      assert.equal(
        record.decision,
        expected,
        `n=${n} states=${states.join(',')} -> expected ${expected}, got ${record.decision}`
      );
      // Cross-check the reason/conflict bookkeeping against the same table.
      const applicable = states.filter((s) => s !== OFF);
      if (applicable.length === 0) {
        assert.equal(record.reason, 'no_matching_rule');
      } else if (applicable.includes(ALLOW) && applicable.includes(DENY)) {
        assert.equal(record.reason, 'conflict_default_deny');
        assert.equal(record.conflict.rules.length, applicable.length);
      } else {
        assert.equal(record.reason, 'rule');
        assert.equal(record.conflict, null);
      }
      cases++;
    }
  }
  assert.equal(cases, 9840); // sum of 3^n for n = 1..8
});
