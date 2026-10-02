import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { verifyViewFile } from '../src/views.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const quiet = { out: () => {}, err: () => {} };

function setupWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gate-revoke-'));
  for (const name of ['field-policy.json', 'reports.jsonl', 'redactions.jsonl']) {
    copyFileSync(new URL(name, FIXTURES), path.join(dir, name));
  }
  return dir;
}

function argsFor(dir) {
  return [
    '--reports', path.join(dir, 'reports.jsonl'),
    '--policy', path.join(dir, 'field-policy.json'),
    '--redactions', path.join(dir, 'redactions.jsonl'),
    '--views', path.join(dir, 'views'),
    '--audit', path.join(dir, 'leak-audit.jsonl'),
  ];
}

function readViews(dir) {
  const viewsDir = path.join(dir, 'views');
  return readdirSync(viewsDir)
    .filter((name) => name.endsWith('.view.json'))
    .map((name) => ({ fileName: name, ...JSON.parse(readFileSync(path.join(viewsDir, name), 'utf8')) }));
}

test('B: after revocation the old view keeps its hash, is marked expired, and stays verifiable', () => {
  const dir = setupWorkspace();
  assert.equal(main(argsFor(dir), quiet), 0);

  const before = readViews(dir);
  const oldSupplier = before.find((v) => v.reportId === 'r-001' && v.audience === 'supplier');
  assert.ok(oldSupplier);
  assert.equal(oldSupplier.status, 'active');
  assert.ok('downtime_minutes' in oldSupplier.fields);
  const oldHash = oldSupplier.hash;

  // revoke sharing of downtime_minutes with the supplier
  appendFileSync(path.join(dir, 'redactions.jsonl'),
    '{"action":"revoke","audience":"supplier","field":"downtime_minutes"}\n');
  assert.equal(main(argsFor(dir), quiet), 0);

  const after = readViews(dir);
  const supplierViews = after.filter((v) => v.reportId === 'r-001' && v.audience === 'supplier');
  assert.equal(supplierViews.length, 2);

  const expired = supplierViews.find((v) => v.status === 'expired');
  assert.ok(expired, 'old view must be marked expired');
  assert.equal(expired.hash, oldHash, 'expired view keeps its original hash');
  assert.ok(verifyViewFile(expired), 'expired view hash still verifies against its fields');
  assert.ok('downtime_minutes' in expired.fields, 'expired view is kept as generated');

  const active = supplierViews.find((v) => v.status === 'active');
  assert.ok(active, 'a new active view must exist');
  assert.ok(!('downtime_minutes' in active.fields), 'new view must not contain the revoked field');
  assert.ok(verifyViewFile(active));
});

test('B: views for audiences unaffected by a revocation stay active', () => {
  const dir = setupWorkspace();
  assert.equal(main(argsFor(dir), quiet), 0);
  appendFileSync(path.join(dir, 'redactions.jsonl'),
    '{"action":"revoke","audience":"supplier","field":"downtime_minutes"}\n');
  assert.equal(main(argsFor(dir), quiet), 0);
  const views = readViews(dir);
  const hqViews = views.filter((v) => v.audience === 'hq');
  assert.ok(hqViews.length > 0);
  assert.ok(hqViews.every((v) => v.status === 'active'));
});

test('exit 30: revoking a regulatory field is rejected', () => {
  const dir = setupWorkspace();
  writeFileSync(path.join(dir, 'redactions.jsonl'),
    '{"action":"revoke","audience":"*","field":"safety_interlock_status"}\n');
  assert.equal(main(argsFor(dir), quiet), 30);
});

test('exit 28: unknown classification in a report is rejected', () => {
  const dir = setupWorkspace();
  appendFileSync(path.join(dir, 'reports.jsonl'),
    '{"id":"r-003","fields":{"line_id":"L9","mystery_field":1}}\n');
  assert.equal(main(argsFor(dir), quiet), 28);
});

test('exit 29: an existing view whose input report vanished is rejected', () => {
  const dir = setupWorkspace();
  assert.equal(main(argsFor(dir), quiet), 0);
  // drop r-002 from the reports: the previously generated view loses its input
  const reports = readFileSync(path.join(dir, 'reports.jsonl'), 'utf8')
    .trim().split('\n').filter((line) => !line.includes('"r-002"'));
  writeFileSync(path.join(dir, 'reports.jsonl'), reports.join('\n') + '\n');
  assert.equal(main(argsFor(dir), quiet), 29);
});

test('exit 29: an existing view whose input report changed is rejected', () => {
  const dir = setupWorkspace();
  assert.equal(main(argsFor(dir), quiet), 0);
  const tampered = readFileSync(path.join(dir, 'reports.jsonl'), 'utf8')
    .replace('"downtime_minutes":47', '"downtime_minutes":48');
  writeFileSync(path.join(dir, 'reports.jsonl'), tampered);
  assert.equal(main(argsFor(dir), quiet), 29);
});

test('happy path: views directory and leak-audit.jsonl are produced, audit is clean', () => {
  const dir = setupWorkspace();
  assert.equal(main(argsFor(dir), quiet), 0);
  const views = readViews(dir);
  // 2 reports x (operator, supplier, hq, joint)
  assert.equal(views.length, 8);
  assert.ok(views.every((v) => v.status === 'active' && verifyViewFile(v)));
  const audit = readFileSync(path.join(dir, 'leak-audit.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 8);
  assert.ok(audit.every((entry) => entry.ok && entry.violations.length === 0));
});
