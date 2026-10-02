import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/evaluate.js';
import { referenceDecision } from '../src/reference.js';
import { makePolicy } from './support/helpers.js';

const SKELETON = {
  roles: { anyone: {}, user: { inherits: ['anyone'] }, operator: { inherits: ['user'] } },
  zones: { plant: {}, cellA: { inherits: ['plant'] } },
  subjects: { alice: { roles: ['operator'] }, carol: { roles: ['user'] } },
  devices: { press1: { zone: 'cellA' } },
};

const ROLE_CYCLE = ['operator', 'anyone', undefined];
const ZONE_CYCLE = ['cellA', 'plant', undefined];

function template(i) {
  const rule = {
    id: `rule-${i}`,
    effect: 'allow',
    action: i % 2 === 0 ? 'openMold' : '*',
  };
  const role = ROLE_CYCLE[i % 3];
  const zone = ZONE_CYCLE[(i + 1) % 3];
  if (role) rule.role = role;
  if (zone) rule.zone = zone;
  if (i === 0) rule.window = { start: '08:00', end: '18:00' };
  return rule;
}

const REQUESTS = [
  { id: 'd-in', subject: 'alice', device: 'press1', action: 'openMold', time: '2026-01-05T10:00:00Z' },
  { id: 'd-out', subject: 'alice', device: 'press1', action: 'openMold', time: '2026-01-05T20:00:00Z' },
  { id: 'd-user', subject: 'carol', device: 'press1', action: 'openMold', time: '2026-01-05T10:00:00Z' },
];

test('D: truth table over effect assignments for n<=8 rules matches reference', () => {
  let comparisons = 0;
  for (let n = 1; n <= 8; n += 1) {
    const templates = Array.from({ length: n }, (_, i) => template(i));
    for (let mask = 0; mask < 2 ** n; mask += 1) {
      const rules = templates.map((t, i) => ({
        ...t,
        effect: (mask >> i) & 1 ? 'deny' : 'allow',
      }));
      const policies = makePolicy({ ...SKELETON, rules });
      for (const req of REQUESTS) {
        const actual = evaluate(policies, req, { counterexample: false }).decision;
        const expected = referenceDecision(policies, req);
        assert.equal(
          actual, expected,
          `n=${n} mask=${mask.toString(2)} req=${req.id}: engine=${actual} reference=${expected}`,
        );
        comparisons += 1;
      }
    }
  }
  assert.equal(comparisons, (2 ** 9 - 2) * REQUESTS.length); // sum(2^n, n=1..8) * 3 = 1530
});
