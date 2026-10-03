'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../cli.js');

function run(args) {
  const { exitCode, payload } = runCli(args);
  return { code: exitCode, json: payload };
}

function tmpFile(name, content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), name);
  fs.writeFileSync(file, content);
  return file;
}

test('cli check: accepts a legal log (exit 0)', () => {
  const flow = tmpFile('flow.re', 'apply review release post\n');
  const log = tmpFile('log.jsonl', '"apply"\n"review"\n"release"\n"post"\n');
  const { code, json } = run(['check', flow, log]);
  assert.equal(code, 0);
  assert.equal(json.accept, true);
  assert.equal(json.witness.states.length, 5);
});

test('cli check: rejects and emits repairs (exit 1)', () => {
  const flow = tmpFile('flow.re', 'apply review release post\n');
  const log = tmpFile('log.jsonl', '{"event":"apply"}\n{"event":"release"}\n{"event":"post"}\n');
  const { code, json } = run(['check', flow, log]);
  assert.equal(code, 1);
  assert.equal(json.accept, false);
  assert.deepEqual(json.repairs[0].ops, [{ op: 'insert', event: 'review', pos: 1 }]);
});

test('cli check: NO_REPAIR_WITHIN_K surfaces as repairError', () => {
  const flow = tmpFile('flow.re', 'apply review release post apply review release post\n');
  const log = tmpFile('log.jsonl', '');
  const { code, json } = run(['check', flow, log]);
  assert.equal(code, 1);
  assert.equal(json.repairError.code, 'NO_REPAIR_WITHIN_K');
});

test('cli check: domain errors exit 2 with the error code', () => {
  const flow = tmpFile('flow.re', 'eps\n');
  const log = tmpFile('log.jsonl', '');
  const { code, json } = run(['check', flow, log]);
  assert.equal(code, 2);
  assert.equal(json.error, 'EMPTY_ALPHABET');
});

test('cli equiv: reports equivalence and distinguishing witnesses', () => {
  const left = tmpFile('left.re', 'apply (review)? release\n');
  const right = tmpFile('right.re', 'apply release\n');
  const same = tmpFile('same.re', 'apply review release | apply release\n');
  const eq = run(['equiv', left, same]);
  assert.equal(eq.code, 0);
  assert.equal(eq.json.equiv, true);
  const neq = run(['equiv', left, right]);
  assert.equal(neq.code, 1);
  assert.equal(neq.json.equiv, false);
  assert.deepEqual(neq.json.witness.events, ['apply', 'review', 'release']);
  assert.equal(neq.json.enumerator.reproduced, true);
});
