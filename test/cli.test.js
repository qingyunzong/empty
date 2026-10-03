'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function runCli(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riskctl-'));
  const input = path.join(dir, 'ops.jsonl');
  const output = path.join(dir, 'report.json');
  fs.writeFileSync(input, lines.join('\n') + '\n');
  let out = '';
  let err = '';
  const code = run([input, output], { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  return { code, out, err, report };
}

test('CLI writes report and exits 0 when all ops succeed', () => {
  const { code, report } = runCli([
    '{"op":"config","totalLimit":100,"categoryLimits":{"a":50}}',
    '{"ts":1,"id":"f1","op":"freeze","start":10,"end":20}',
    '{"ts":2,"id":"d1","op":"debit","amount":30,"scope":"a"}',
  ]);
  assert.equal(code, 0);
  assert.equal(report.steps.length, 2);
  assert.ok(report.steps.every((s) => s.ok));
  assert.equal(report.final.available, 60);
  assert.deepEqual(report.final.frozen, [[10, 20]]);
  assert.equal(report.audit.length, 2);
});

test('CLI exits 1 and logs failed ops to stderr, still writes report', () => {
  const { code, err, report } = runCli([
    '{"op":"config","totalLimit":100}',
    '{"ts":1,"id":"a","op":"debit","amount":60,"scope":"s"}',
    '{"ts":1,"id":"b","op":"debit","amount":60,"scope":"s"}',
  ]);
  assert.equal(code, 1);
  assert.match(err, /E_LIMIT: id=b/);
  assert.equal(report.steps[0].id, 'a');
  assert.equal(report.steps[0].ok, true);
  assert.equal(report.steps[1].ok, false);
  assert.equal(report.steps[1].reason, 'E_LIMIT');
});

test('CLI rejects missing config line with E_RANGE on stderr and exit 1', () => {
  const { code, err, report } = runCli([
    '{"ts":1,"id":"a","op":"debit","amount":1,"scope":"s"}',
  ]);
  assert.equal(code, 1);
  assert.match(err, /E_RANGE/);
  assert.equal(report, null);
});

test('CLI rejects malformed JSONL with E_RANGE on stderr and exit 1', () => {
  const { code, err } = runCli([
    '{"op":"config","totalLimit":100}',
    '{not json}',
  ]);
  assert.equal(code, 1);
  assert.match(err, /E_RANGE: line 2/);
});
