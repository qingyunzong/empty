'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeView } = require('../src/views');
const { revokedFields } = require('../src/redactions');
const { writeView, verifyViewsDir } = require('../src/viewstore');
const { fixturePolicy, fixtureReport } = require('./helpers');

// Acceptance B: after revocation the old view is expired but still verifiable,
// and the new view must not contain the revoked field.
test('revocation expires old view, new view drops revoked field', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'));

  const before = computeView(policy, report, 'supplier');
  assert.ok('root_cause' in before.fields);
  const first = writeView(dir, before);

  const revoked = revokedFields(policy, [
    { type: 'revoke', principal: 'supplier', fields: ['root_cause'] },
  ]);
  const after = computeView(policy, report, 'supplier', revoked);
  assert.ok(!('root_cause' in after.fields)); // new view must not contain revoked field
  assert.ok(after.omitted.includes('root_cause'));
  const second = writeView(dir, after);

  assert.equal(second.expired.length, 1);
  const expiredDoc = JSON.parse(fs.readFileSync(path.join(dir, second.expired[0]), 'utf8'));
  assert.equal(expiredDoc.status, 'expired');
  assert.equal(expiredDoc.hash, first.hash); // hash preserved
  assert.equal(expiredDoc.supersededBy, second.hash);

  // expired view remains verifiable alongside the current one
  const results = verifyViewsDir(dir);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.ok));
  assert.ok(results.some((r) => r.status === 'expired'));
  assert.ok(results.some((r) => r.status === 'current'));
});

test('revoking a regulatory field exits 30', () => {
  const policy = fixturePolicy();
  assert.throws(
    () => revokedFields(policy, [{ type: 'revoke', principal: 'supplier', fields: ['safety_code'] }]),
    (err) => err.exitCode === 30
  );
});

test('revoked pii field is omitted entirely, not nulled', () => {
  const policy = fixturePolicy();
  const report = fixtureReport();
  const revoked = revokedFields(policy, [
    { type: 'revoke', principal: 'supplier', fields: ['operator_name'] },
  ]);
  const view = computeView(policy, report, 'supplier', revoked);
  assert.ok(!('operator_name' in view.fields));
});
