'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeView, computeSharedView } = require('../src/views');
const { parsePolicy } = require('../src/policy');

// Acceptance D: for <= 15 fields, enumerate every possible report (all 2^n
// field subsets) and cross-check every view against an independent
// brute-force reference implementation.

const N = 15;

function enumerationPolicy() {
  const fields = {};
  for (let i = 0; i < N; i++) {
    const def = { classification: ['public', 'internal', 'confidential', 'secret'][i % 4] };
    const labels = [];
    if (i % 5 === 0) labels.push('pii');
    if (i % 7 === 0) labels.push('regulatory');
    if (i % 3 === 0) labels.push('recipe');
    if (labels.length) def.labels = labels;
    fields[`f${i}`] = def;
  }
  return parsePolicy(
    JSON.stringify({
      classifications: { public: 0, internal: 1, confidential: 2, secret: 3 },
      labels: {
        recipe: { upgradeTo: 'secret' },
        pii: { upgradeTo: 'confidential' },
        regulatory: { regulatory: true },
      },
      fields,
      orgs: {
        orgA: { clearance: 'internal', allow: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'] },
        orgB: { clearance: 'secret', allow: ['f2', 'f3', 'f5', 'f8', 'f9', 'f10', 'f11', 'f13'] },
        orgC: { clearance: 'confidential', allow: ['f1', 'f4', 'f6', 'f12', 'f14'] },
      },
      roles: {
        supplier: { org: 'orgA', allow: ['f8', 'f12'], deny: ['f3'] },
        hq: { org: 'orgB', allow: ['f0', 'f14'], deny: ['f9'] },
        operator: { org: 'orgC', allow: ['f2'], deny: [] },
      },
    })
  );
}

// --- independent brute-force reference ---
function bruteChain(policy, principal) {
  const role = policy.roles[principal];
  return [policy.orgs[role.org], role];
}

function bruteView(policy, principal, reportFields) {
  const chain = bruteChain(policy, principal);
  let clearance = 0;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].clearance !== undefined) {
      clearance = policy.classifications[chain[i].clearance];
      break;
    }
  }
  const out = {};
  for (const field of Object.keys(reportFields)) {
    const def = policy.fields[field];
    if (!def) continue;
    let level = policy.classifications[def.classification];
    for (const label of def.labels || []) {
      const up = policy.labels[label] && policy.labels[label].upgradeTo;
      if (up) level = Math.max(level, policy.classifications[up]);
    }
    let granted = false;
    let denied = false;
    for (const scope of chain) {
      if ((scope.allow || []).includes(field)) granted = true;
      if ((scope.deny || []).includes(field)) denied = true;
    }
    if (granted && !denied && clearance >= level) {
      out[field] = reportFields[field];
    } else if ((def.labels || []).includes('pii')) {
      out[field] = null;
    }
  }
  return out;
}

function bruteShared(policy, reportFields) {
  const a = bruteView(policy, 'supplier', reportFields);
  const b = bruteView(policy, 'hq', reportFields);
  const out = {};
  for (const field of Object.keys(a)) {
    if (a[field] !== null && b[field] !== undefined && b[field] !== null) {
      out[field] = a[field];
    }
  }
  for (const field of Object.keys(reportFields)) {
    const def = policy.fields[field];
    const reg =
      def &&
      (def.regulatory === true ||
        (def.labels || []).some((l) => policy.labels[l] && policy.labels[l].regulatory === true));
    if (reg) out[field] = reportFields[field];
  }
  return out;
}
// --- end reference ---

test('enumerate all 2^15 field subsets and cross-check every view', () => {
  const policy = enumerationPolicy();
  const names = Object.keys(policy.fields);
  assert.equal(names.length, N);
  const total = 1 << N;
  for (let mask = 0; mask < total; mask++) {
    const reportFields = {};
    for (let bit = 0; bit < N; bit++) {
      if (mask & (1 << bit)) reportFields[names[bit]] = bit * 10 + 1;
    }
    const report = { id: `r-${mask}`, fields: reportFields };

    for (const principal of ['supplier', 'hq', 'operator']) {
      const actual = computeView(policy, report, principal).fields;
      const expected = bruteView(policy, principal, reportFields);
      assert.deepEqual(actual, expected, `${principal} view mismatch for mask ${mask}`);
    }

    const supplier = computeView(policy, report, 'supplier');
    const hq = computeView(policy, report, 'hq');
    const shared = computeSharedView(policy, report, supplier, hq, 'supplier', 'hq').fields;
    assert.deepEqual(shared, bruteShared(policy, reportFields), `shared view mismatch for mask ${mask}`);
  }
});
