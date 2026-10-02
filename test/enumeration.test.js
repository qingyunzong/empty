import test from 'node:test';
import assert from 'node:assert/strict';
import { computeView } from '../src/views.js';
import { isRevoked } from '../src/redactions.js';
import { LEVELS } from '../src/policy.js';

// Acceptance D: for <= 15 fields, enumerate every possible report (every
// subset of fields) and cross-check the view engine against an independent
// brute-force verifier that expands grants downward through the hierarchy.

const FIELD_SPECS = [
  ['op0', 'operational'], ['op1', 'operational'], ['op2', 'operational'],
  ['op3', 'operational'], ['op4', 'operational'], ['op5', 'operational'],
  ['p0', 'personal'], ['p1', 'personal'], ['p2', 'personal'], ['p3', 'personal'],
  ['r0', 'recipe'], ['r1', 'recipe'], ['r2', 'recipe'],
  ['g0', 'regulatory'], ['g1', 'regulatory'],
];
const FIELDS = FIELD_SPECS.map(([name]) => name);

const policy = {
  classifications: {
    operational: { minLevel: 'org' },
    personal: { minLevel: 'role', boundary: 'null' },
    recipe: { minLevel: 'individual' },
    regulatory: { minLevel: 'org', forced: true },
  },
  fields: Object.fromEntries(FIELD_SPECS.map(([name, cls]) => [name, { classification: cls }])),
  principals: {
    plant: { kind: 'org' },
    vendor: { kind: 'org' },
    tech: { kind: 'role', org: 'plant' },
    bob: { kind: 'individual', role: 'tech' },
  },
  grants: {
    org: {
      plant: ['op0', 'op1', 'op2', 'p0', 'p1'],
      vendor: ['op0', 'op2', 'op4'],
    },
    role: { tech: ['op1', 'op3', 'p0', 'p2'] },
    individual: { bob: ['r0', 'r2', 'p3'] },
  },
};

const redactions = [
  { action: 'revoke', audience: 'vendor', field: 'op4' },
  { action: 'revoke', audience: '*', field: 'op5' },
];

// --- independent verifier: downward reachability, no use of src/views.js ---

function childrenIndex(policyObj) {
  const children = new Map();
  const add = (from, to) => {
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
  };
  for (const [id, p] of Object.entries(policyObj.principals)) {
    if (p.kind === 'role' && p.org) add(`org:${p.org}`, `role:${id}`);
    if (p.kind === 'individual' && p.role) add(`role:${p.role}`, `individual:${id}`);
  }
  return children;
}

function reachable(children, fromKey, toKey) {
  const queue = [fromKey];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === toKey) return true;
    for (const next of children.get(key) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function bruteForceAuthorized(policyObj, audienceId, field) {
  const cls = policyObj.fields[field].classification;
  const meta = policyObj.classifications[cls];
  if (meta.forced === true) return true;
  const minLevel = meta.minLevel ?? 'org';
  const target = `${policyObj.principals[audienceId].kind}:${audienceId}`;
  const children = childrenIndex(policyObj);
  for (const [level, byId] of Object.entries(policyObj.grants)) {
    for (const [id, grantedFields] of Object.entries(byId)) {
      if (!grantedFields.includes(field)) continue;
      if (LEVELS[level] < LEVELS[minLevel]) continue;
      if (reachable(children, `${level}:${id}`, target)) return true;
    }
  }
  return false;
}

function bruteForceExpectation(audienceId, field) {
  if (isRevoked(redactions, audienceId, field)) return 'absent';
  const meta = policy.classifications[policy.fields[field].classification];
  if (meta.forced === true) return 'value';
  if (bruteForceAuthorized(policy, audienceId, field)) return 'value';
  if (meta.boundary === 'null') return 'null';
  return 'absent';
}

test('D: enumerate all 2^15 field subsets and cross-check engine vs brute force', () => {
  assert.equal(FIELDS.length, 15);
  const audiences = ['vendor', 'tech', 'bob'];
  let checked = 0;
  for (const audience of audiences) {
    for (let mask = 0; mask < 2 ** FIELDS.length; mask += 1) {
      const subset = {};
      for (let bit = 0; bit < FIELDS.length; bit += 1) {
        if (mask & (1 << bit)) subset[FIELDS[bit]] = bit * 10 + 1;
      }
      const view = computeView(policy, redactions, audience, subset).fields;
      for (const field of FIELDS) {
        const present = Object.hasOwn(subset, field);
        const expected = present ? bruteForceExpectation(audience, field) : 'absent';
        if (expected === 'value') {
          assert.equal(view[field], subset[field], `${audience}/${field}/mask=${mask}`);
        } else if (expected === 'null') {
          assert.ok(Object.hasOwn(view, field) && view[field] === null, `${audience}/${field}/mask=${mask}`);
        } else {
          assert.ok(!Object.hasOwn(view, field), `${audience}/${field}/mask=${mask}`);
        }
      }
      // no extra fields beyond the subset
      for (const field of Object.keys(view)) {
        assert.ok(Object.hasOwn(subset, field), `unexpected ${field} for ${audience}`);
      }
      checked += 1;
    }
  }
  assert.equal(checked, 3 * 2 ** 15);
});
