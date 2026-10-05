import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { and, attr, cmp, lit, not, or } from '../src/expr.js';
import { evaluate, type Policy } from '../src/policy.js';
import { Rational } from '../src/rational.js';

const policy: Policy = {
  id: 'demo',
  rules: [
    { id: 'p-adult', effect: 'permit', when: cmp('ge', attr('age'), lit(18)) },
    { id: 'p-vip', effect: 'permit', when: cmp('eq', attr('vip'), lit(true)) },
    { id: 'd-banned', effect: 'deny', when: cmp('eq', attr('banned'), lit(true)) },
    { id: 'd-balance', effect: 'deny', when: cmp('lt', attr('balance'), lit('1/2')) },
  ],
};

test('permit only when a permit rule is exactly true', () => {
  const res = evaluate(policy, { age: Rational.of(20), banned: false, balance: Rational.of(1) });
  equal(res.decision, 'permit');
  deepEqual(res.decisiveRuleIds, ['p-adult', 'd-banned', 'd-balance']);
});

test('unknown permit does not allow (default deny, decisive = all permit rules)', () => {
  const res = evaluate(policy, { banned: false, balance: Rational.of(1) });
  equal(res.decision, 'deny');
  const permit = res.ruleResults.find((r) => r.id === 'p-adult')!;
  equal(permit.value, 'U');
  deepEqual(res.decisiveRuleIds, ['p-adult', 'p-vip']);
});

test('unknown deny does not deny by itself', () => {
  const res = evaluate(policy, { age: Rational.of(30), vip: false });
  equal(res.decision, 'permit');
  const deny = res.ruleResults.find((r) => r.id === 'd-banned')!;
  equal(deny.value, 'U');
});

test('any true deny rule denies, even with a true permit rule', () => {
  const res = evaluate(policy, {
    age: Rational.of(30),
    banned: true,
    balance: Rational.of(1),
  });
  equal(res.decision, 'deny');
  deepEqual(res.decisiveRuleIds, ['d-banned']);
});

test('exact rational comparison drives decisions', () => {
  const low = evaluate(policy, {
    age: Rational.of(40),
    banned: false,
    balance: Rational.parse('1/3'),
  });
  equal(low.decision, 'deny');
  deepEqual(low.decisiveRuleIds, ['d-balance']);
  const exact = evaluate(policy, {
    age: Rational.of(40),
    banned: false,
    balance: Rational.parse('2/4'),
  });
  equal(exact.decision, 'permit');
});

test('missing attribute is unknown, not false', () => {
  const res = evaluate(policy, { age: Rational.of(25), banned: false, balance: Rational.of(9) });
  const vip = res.ruleResults.find((r) => r.id === 'p-vip')!;
  equal(vip.value, 'U');
  equal(res.decision, 'permit');
});

test('mixed-type and boolean ordering comparisons are unknown', () => {
  const p: Policy = {
    rules: [
      { id: 'p1', effect: 'permit', when: cmp('eq', attr('flag'), lit(1)) },
      { id: 'p2', effect: 'permit', when: cmp('lt', attr('flag'), lit(true)) },
    ],
  };
  const res = evaluate(p, { flag: true });
  deepEqual(res.ruleResults.map((r) => r.value), ['U', 'U']);
  equal(res.decision, 'deny');
});

test('boolean equality works on boolean attributes', () => {
  const p: Policy = {
    rules: [{ id: 'p1', effect: 'permit', when: cmp('ne', attr('flag'), lit(false)) }],
  };
  equal(evaluate(p, { flag: true }).decision, 'permit');
  equal(evaluate(p, { flag: false }).decision, 'deny');
  equal(evaluate(p, {}).decision, 'deny');
});

test('policy without permit rules: empty decisive set, always deny', () => {
  const p: Policy = {
    rules: [{ id: 'd1', effect: 'deny', when: cmp('eq', attr('x'), lit(1)) }],
  };
  const res = evaluate(p, { x: Rational.of(1) });
  equal(res.decision, 'deny');
  deepEqual(res.decisiveRuleIds, []);
});

test('boolean connectives compose with three-valued semantics', () => {
  const p: Policy = {
    rules: [
      {
        id: 'p1',
        effect: 'permit',
        when: and(
          cmp('ge', attr('age'), lit(18)),
          or(cmp('eq', attr('vip'), lit(true)), not(cmp('eq', attr('banned'), lit(true)))),
        ),
      },
    ],
  };
  equal(evaluate(p, { age: Rational.of(18), banned: false }).decision, 'permit');
  // age unknown, vip true -> and(U, T) = U -> default deny.
  equal(evaluate(p, { vip: true }).decision, 'deny');
});
