'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const EXAMPLES = path.join(__dirname, '..', 'examples');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cli-'));
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

function copyExamples(dir) {
  for (const f of ['field-policy.json', 'reports.jsonl', 'redactions.jsonl']) {
    fs.copyFileSync(path.join(EXAMPLES, f), path.join(dir, f));
  }
}

test('generate produces views/ and leak-audit.jsonl, verify passes', () => {
  const dir = tmpdir();
  copyExamples(dir);
  const gen = runCli(
    ['generate', '--policy', 'field-policy.json', '--reports', 'reports.jsonl',
     '--redactions', 'redactions.jsonl', '--out', 'views', '--audit', 'leak-audit.jsonl'],
    dir
  );
  assert.equal(gen.status, 0, gen.stderr);
  const viewFiles = fs.readdirSync(path.join(dir, 'views')).filter((f) => f.endsWith('.json'));
  assert.ok(viewFiles.length > 0);
  const audit = fs.readFileSync(path.join(dir, 'leak-audit.jsonl'), 'utf8').trim().split('\n');
  assert.ok(audit.some((l) => JSON.parse(l).type === 'view-audit'));
  assert.ok(audit.some((l) => JSON.parse(l).type === 'counterexample'));

  const verify = runCli(['verify', '--views', 'views'], dir);
  assert.equal(verify.status, 0, verify.stderr);
});

test('revocation flow via CLI: old view expired, new view clean, verify ok', () => {
  const dir = tmpdir();
  copyExamples(dir);
  fs.writeFileSync(path.join(dir, 'redactions.jsonl'), ''); // no redactions yet
  const args = ['generate', '--policy', 'field-policy.json', '--reports', 'reports.jsonl',
    '--redactions', 'redactions.jsonl', '--out', 'views', '--audit', 'leak-audit.jsonl'];
  assert.equal(runCli(args, dir).status, 0);
  const first = JSON.parse(fs.readFileSync(path.join(dir, 'views', 'supplier.rpt-001.json'), 'utf8'));
  assert.ok('root_cause' in first.inputs.fields);

  fs.writeFileSync(
    path.join(dir, 'redactions.jsonl'),
    JSON.stringify({ type: 'revoke', principal: 'supplier', fields: ['root_cause'] }) + '\n'
  );
  assert.equal(runCli(args, dir).status, 0);

  const files = fs.readdirSync(path.join(dir, 'views'));
  const expired = files.filter((f) => f.startsWith('supplier.rpt-001.expired.'));
  assert.equal(expired.length, 1);
  const expiredDoc = JSON.parse(fs.readFileSync(path.join(dir, 'views', expired[0]), 'utf8'));
  assert.equal(expiredDoc.status, 'expired');
  assert.equal(expiredDoc.hash, first.hash);

  const current = JSON.parse(fs.readFileSync(path.join(dir, 'views', 'supplier.rpt-001.json'), 'utf8'));
  assert.ok(!('root_cause' in current.inputs.fields));

  const verify = runCli(['verify', '--views', 'views'], dir);
  assert.equal(verify.status, 0, verify.stderr);
});

test('unknown classification exits 28', () => {
  const dir = tmpdir();
  copyExamples(dir);
  const policy = JSON.parse(fs.readFileSync(path.join(dir, 'field-policy.json'), 'utf8'));
  policy.fields.root_cause.classification = 'mystery';
  fs.writeFileSync(path.join(dir, 'field-policy.json'), JSON.stringify(policy));
  const res = runCli(
    ['generate', '--policy', 'field-policy.json', '--reports', 'reports.jsonl', '--out', 'views'],
    dir
  );
  assert.equal(res.status, 28);
});

test('view hash missing input exits 29', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'views'));
  fs.writeFileSync(
    path.join(dir, 'views', 'supplier.rpt-001.json'),
    JSON.stringify({ view: 'supplier', report: 'rpt-001', hash: 'deadbeef' })
  );
  const res = runCli(['verify', '--views', 'views'], dir);
  assert.equal(res.status, 29);
});

test('regulatory field deleted exits 30', () => {
  const dir = tmpdir();
  copyExamples(dir);
  fs.writeFileSync(
    path.join(dir, 'redactions.jsonl'),
    JSON.stringify({ type: 'revoke', principal: 'supplier', fields: ['safety_code'] }) + '\n'
  );
  const res = runCli(
    ['generate', '--policy', 'field-policy.json', '--reports', 'reports.jsonl',
     '--redactions', 'redactions.jsonl', '--out', 'views'],
    dir
  );
  assert.equal(res.status, 30);
});
