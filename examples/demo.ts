import { and, attr, cmp, lit, not } from '../src/expr.js';
import { evaluate, type Policy } from '../src/policy.js';
import { Rational } from '../src/rational.js';
import { verifyPolicyExhaustive } from '../src/verify.js';

const policy: Policy = {
  id: 'loan',
  rules: [
    {
      id: 'p-solvent-adult',
      effect: 'permit',
      when: and(cmp('ge', attr('age'), lit(18)), cmp('ge', attr('balance'), lit('3/2'))),
    },
    { id: 'p-vip', effect: 'permit', when: cmp('eq', attr('vip'), lit(true)) },
    { id: 'd-minor', effect: 'deny', when: cmp('lt', attr('age'), lit(18)) },
    { id: 'd-overdrawn', effect: 'deny', when: not(cmp('ge', attr('balance'), lit(0))) },
  ],
};

const cases: [string, Record<string, boolean | Rational>][] = [
  ['adult solvent', { age: Rational.of(25), balance: Rational.parse('7/4'), vip: false }],
  ['vip, balance missing', { age: Rational.of(40), vip: true }],
  ['minor', { age: Rational.of(15), balance: Rational.of(10), vip: true }],
  ['everything missing', {}],
];

for (const [label, attrs] of cases) {
  const res = evaluate(policy, attrs);
  console.log(`case: ${label}`);
  console.log(`  decision:          ${res.decision}`);
  console.log(
    `  rule results:      ${res.ruleResults.map((r) => `${r.id}=${r.value}`).join(' ')}`,
  );
  console.log(`  minimal decisive:  [${res.decisiveRuleIds.join(', ')}]`);
}

const report = verifyPolicyExhaustive(policy, {
  age: [15, 18, 40],
  balance: ['-1/2', 0, '3/2'],
  vip: [true, false],
});
console.log(
  `exhaustive check: ${report.assignmentsChecked} assignments, ` +
    `${report.failures.length === 0 ? 'no failures' : report.failures.join('; ')}`,
);
