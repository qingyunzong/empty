import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { and, attr, cmp, lit, not } from '../src/expr.js';
import type { Policy } from '../src/policy.js';
import {
  bruteForceMinimalDecisive,
  enumerateAssignments,
  isDecisive,
  verifyPolicyExhaustive,
} from '../src/verify.js';
import type { RuleResult } from '../src/policy.js';

const smallPolicy: Policy = {
  id: 'small',
  rules: [
    {
      id: 'p-main',
      effect: 'permit',
      when: and(cmp('eq', attr('flag'), lit(true)), cmp('ge', attr('quota'), lit(1))),
    },
    { id: 'p-fallback', effect: 'permit', when: cmp('ge', attr('quota'), lit('3/2')) },
    { id: 'd-low', effect: 'deny', when: cmp('lt', attr('quota'), lit('1/2')) },
    { id: 'd-off', effect: 'deny', when: not(cmp('ne', attr('flag'), lit(false))) },
  ],
};

const domains = {
  flag: [true, false],
  quota: [0, '1/2', 1, '3/2'],
} as const;

test('exhaustive attribute check passes on a small policy', () => {
  const report = verifyPolicyExhaustive(smallPolicy, domains);
  equal(report.assignmentsChecked, 3 * 5);
  deepEqual(report.failures, []);
});

test('exhaustive check passes on a deny-only policy', () => {
  const denyOnly: Policy = {
    rules: [{ id: 'd1', effect: 'deny', when: cmp('eq', attr('flag'), lit(true)) }],
  };
  const report = verifyPolicyExhaustive(denyOnly, { flag: [true, false] });
  equal(report.assignmentsChecked, 3);
  deepEqual(report.failures, []);
});

test('enumeration covers missing plus every domain value', () => {
  const all = [...enumerateAssignments({ a: [true], b: [0, 1] })];
  equal(all.length, 2 * 3);
  ok(all.some((attrs) => attrs['a'] === undefined && attrs['b'] === undefined));
});

test('isDecisive: a true deny rule alone fixes a deny decision', () => {
  const results: RuleResult[] = [
    { id: 'p1', effect: 'permit', value: 'U' },
    { id: 'd1', effect: 'deny', value: 'T' },
  ];
  ok(isDecisive(results, new Set(['d1']), 'deny'));
  ok(!isDecisive(results, new Set([]), 'deny'));
});

test('isDecisive: permit needs a true permit witness and all deny rules', () => {
  const results: RuleResult[] = [
    { id: 'p1', effect: 'permit', value: 'T' },
    { id: 'd1', effect: 'deny', value: 'F' },
  ];
  ok(isDecisive(results, new Set(['p1', 'd1']), 'permit'));
  ok(!isDecisive(results, new Set(['p1']), 'permit'));
  ok(!isDecisive(results, new Set(['d1']), 'permit'));
});

test('bruteForceMinimalDecisive matches the closed-form construction', () => {
  const permitCase: RuleResult[] = [
    { id: 'p1', effect: 'permit', value: 'T' },
    { id: 'p2', effect: 'permit', value: 'U' },
    { id: 'd1', effect: 'deny', value: 'U' },
  ];
  deepEqual(bruteForceMinimalDecisive(permitCase, 'permit').sort(), ['d1', 'p1']);
  const defaultDeny: RuleResult[] = [
    { id: 'p1', effect: 'permit', value: 'U' },
    { id: 'p2', effect: 'permit', value: 'F' },
    { id: 'd1', effect: 'deny', value: 'U' },
  ];
  deepEqual(bruteForceMinimalDecisive(defaultDeny, 'deny').sort(), ['p1', 'p2']);
});
