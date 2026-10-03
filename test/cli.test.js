'use strict';

// CLI contract: JSON output, rejection codes, exit 8 on
// SKILL_MISMATCH / DEADLINE_PAST / DUPLICATE_APPEAL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const { execute } = require('../cli');

function run(args) {
  try {
    return { code: 0, body: execute(args) };
  } catch (err) {
    if (err instanceof core.AuditError) {
      return { code: err.exitCode, body: { ok: false, error: err.code, message: err.message } };
    }
    throw err;
  }
}

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.json');
}

test('open rejects past deadline with exit 8', (t) => {
  const state = tmpState(t);
  run(['open', '--state', state, '--reviewer', 'R1', '--skills', 'mol']);
  const res = run(['open', '--state', state, '--case', 'C1', '--dept', 'd1', '--risk', '50', '--deadline', '3', '--skill', 'mol', '--now', '5']);
  assert.equal(res.code, 8);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'DEADLINE_PAST');
});

test('open rejects skill mismatch with exit 8', (t) => {
  const state = tmpState(t);
  run(['open', '--state', state, '--reviewer', 'R1', '--skills', 'mol']);
  const res = run(['open', '--state', state, '--case', 'C1', '--dept', 'd1', '--risk', '50', '--deadline', '9', '--skill', 'fish', '--now', '0']);
  assert.equal(res.code, 8);
  assert.equal(res.body.error, 'SKILL_MISMATCH');
});

test('duplicate appeal exits 8', (t) => {
  const state = tmpState(t);
  run(['open', '--state', state, '--reviewer', 'R1', '--skills', 'mol']);
  run(['open', '--state', state, '--case', 'C1', '--dept', 'd1', '--risk', '50', '--deadline', '9', '--skill', 'mol', '--now', '0']);
  run(['assign', '--state', state, '--now', '0']);
  run(['close', '--state', state, '--case', 'C1', '--now', '1']);
  const first = run(['appeal', '--state', state, '--case', 'C1', '--now', '2']);
  assert.equal(first.code, 0);
  const dup = run(['appeal', '--state', state, '--case', 'C1', '--now', '3']);
  assert.equal(dup.code, 8);
  assert.equal(dup.body.error, 'DUPLICATE_APPEAL');
});

test('assign emits assignments, rejection codes and certificate', (t) => {
  const state = tmpState(t);
  run(['open', '--state', state, '--reviewer', 'R1', '--skills', 'mol', '--unavailable', '1-9']);
  run(['open', '--state', state, '--case', 'C1', '--dept', 'd1', '--risk', '80', '--deadline', '9', '--skill', 'mol', '--now', '0']);
  run(['open', '--state', state, '--case', 'C2', '--dept', 'd1', '--risk', '60', '--deadline', '9', '--skill', 'mol', '--now', '0']);
  const res = run(['assign', '--state', state, '--now', '0']);
  assert.equal(res.code, 0);
  assert.equal(res.body.assignments.length, 1);
  assert.equal(res.body.assignments[0].caseId, 'C1'); // higher risk wins the single slot
  assert.equal(res.body.rejections.C2, 'NO_CAPACITY');
  assert.match(res.body.certificate, /^[0-9a-f]{64}$/);
});
