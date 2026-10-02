'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
}

// Drive the CLI in-process with an isolated environment, capturing stdout.
function run(args, env) {
  let text = '';
  const code = main(args, (s) => {
    text += s;
  }, { LEDGER_FILE: env.LEDGER_FILE, REPLICA_ID: env.REPLICA_ID });
  const lines = text.trim().split('\n').filter(Boolean);
  return { code, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null };
}

test('CLI: put/correct/get/audit happy path follows the latest version', () => {
  const dir = workspace();
  const env = { LEDGER_FILE: path.join(dir, 'ledger.json'), REPLICA_ID: 'A' };
  const put = run(['put', '{"voucherId":"v1","amount":100,"status":"issued"}'], env);
  assert.equal(put.code, 0);
  assert.equal(put.json.version, 1);
  const c1 = run(['correct', '{"voucherId":"v1","amount":120,"status":"issued"}'], env);
  assert.equal(c1.code, 0);
  const c2 = run(['correct', '{"voucherId":"v1","amount":90,"status":"settled"}'], env);
  assert.equal(c2.code, 0);
  const got = run(['get', 'v1'], env);
  assert.equal(got.code, 0);
  assert.equal(got.json.version, 3);
  assert.equal(got.json.amount, 90);
  assert.equal(got.json.status, 'settled');
  const audit = run(['audit'], env);
  assert.equal(audit.code, 0);
  assert.equal(audit.json.status, 'valid');
  assert.equal(audit.json.conflicts, 0);
  assert.equal(audit.json.missingDependencies, 0);
  assert.deepEqual(audit.json.frontier.v1, [c2.json.hash]);
  assert.ok(audit.json.voucherHashes.v1);
});

test('CLI: concurrent corrections across replicas conflict and invalidate the certificate', () => {
  const dir = workspace();
  const envA = { LEDGER_FILE: path.join(dir, 'a.json'), REPLICA_ID: 'A' };
  const envB = { LEDGER_FILE: path.join(dir, 'b.json'), REPLICA_ID: 'B' };
  run(['put', '{"voucherId":"v1","amount":100,"status":"issued"}'], envA);
  run(['merge', path.join(dir, 'a.json')], envB);
  run(['correct', '{"voucherId":"v1","amount":150,"status":"issued"}'], envA);
  run(['correct', '{"voucherId":"v1","amount":200,"status":"issued"}'], envB);
  const merge = run(['merge', path.join(dir, 'b.json')], envA);
  assert.equal(merge.code, 0);
  const got = run(['get', 'v1'], envA);
  assert.equal(got.json.conflict, true);
  assert.deepEqual(got.json.heads.map((h) => h.amount).sort(), [150, 200]);
  const audit = run(['audit'], envA);
  assert.equal(audit.json.status, 'invalid');
  assert.equal(audit.json.conflicts, 1);
});

test('CLI: unknown predecessor and stale clock errors are JSON with exit code 1', () => {
  const dir = workspace();
  const env = { LEDGER_FILE: path.join(dir, 'ledger.json'), REPLICA_ID: 'A' };
  run(['put', '{"voucherId":"v1","amount":100,"status":"issued"}'], env);
  run(['correct', '{"voucherId":"v1","amount":120,"status":"issued"}'], env);
  const stale = run(['correct', '{"voucherId":"v1","amount":1,"status":"x","baseVersion":1}'], env);
  assert.equal(stale.code, 1);
  assert.deepEqual(stale.json, { error: 'stale-clock' });
  const unknown = run(['correct', '{"voucherId":"v1","amount":1,"status":"x","baseVersion":42}'], env);
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.json, { error: 'unknown-predecessor' });
  const noVoucher = run(['get', 'nope'], env);
  assert.equal(noVoucher.code, 1);
  assert.deepEqual(noVoucher.json, { error: 'unknown-voucher' });
  const dup = run(['put', '{"voucherId":"v1","amount":1,"status":"x"}'], env);
  assert.equal(dup.code, 1);
  assert.deepEqual(dup.json, { error: 'voucher-exists' });
});
