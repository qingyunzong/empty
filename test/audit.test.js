'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const AUDIT = path.join(__dirname, '..', 'audit.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
}

function run(args) {
  return spawnSync(process.execPath, [AUDIT, ...args], { encoding: 'utf8' });
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('A: as-of query differs before and after a correction', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'entries.jsonl');
  writeJsonl(input, [
    { id: 'e1', account: 'a1', amount: 100, category: 'food', valid: true, corrects: null },
    { id: 'e2', account: 'a1', amount: 150, category: 'food', valid: true, corrects: 'e1' },
  ]);

  const before = run(['build', '--in', input, '--out', path.join(dir, 'asof1'), '--asof', '1']);
  assert.equal(before.status, 0, before.stderr);
  const after = run(['build', '--in', input, '--out', path.join(dir, 'full')]);
  assert.equal(after.status, 0, after.stderr);

  const rBefore = readJson(path.join(dir, 'asof1', 'result.json'));
  const rAfter = readJson(path.join(dir, 'full', 'result.json'));
  assert.deepEqual(rBefore.categories.food, { sum: 100, count: 1 });
  assert.deepEqual(rAfter.categories.food, { sum: 150, count: 1 });
  assert.notEqual(rBefore.root, rAfter.root);

  const proof = readJson(path.join(dir, 'full', 'proof.json'));
  const leaf1 = proof.leaves.find((l) => l.id === 'e1');
  assert.equal(leaf1.included, false, 'superseded row must not be aggregated');
  assert.equal(leaf1.supersededBy, 'e2');
  assert.ok(leaf1.hash, 'superseded row must still appear in the certificate');

  const verify = run(['verify', path.join(dir, 'full'), path.join(dir, 'full', 'proof.json')]);
  assert.equal(verify.status, 0, verify.stderr);
});

test('B: tampering with an unused row breaks the certificate', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'entries.jsonl');
  writeJsonl(input, [
    { id: 'e1', account: 'a1', amount: 100, category: 'food', valid: true, corrects: null },
    { id: 'e2', account: 'a1', amount: 150, category: 'food', valid: true, corrects: 'e1' },
    { id: 'e3', account: 'a2', amount: 40, category: 'travel', valid: false, corrects: null },
  ]);
  const out = path.join(dir, 'out');
  assert.equal(run(['build', '--in', input, '--out', out]).status, 0);
  assert.equal(run(['verify', out, path.join(out, 'proof.json')]).status, 0);

  // e1 is superseded and e3 is invalid: neither feeds the aggregate.
  const snapshot = path.join(out, 'input.snapshot.jsonl');
  const lines = fs.readFileSync(snapshot, 'utf8').trim().split('\n').map(JSON.parse);
  lines.find((l) => l.id === 'e1').amount = 999;
  fs.writeFileSync(snapshot, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const verify = run(['verify', out, path.join(out, 'proof.json')]);
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /E_PROOF/);

  // restore, then tamper the invalid row instead
  lines.find((l) => l.id === 'e1').amount = 100;
  lines.find((l) => l.id === 'e3').amount = 41;
  fs.writeFileSync(snapshot, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const verify2 = run(['verify', out, path.join(out, 'proof.json')]);
  assert.notEqual(verify2.status, 0);
  assert.match(verify2.stderr, /E_PROOF/);
});

test('C: incremental correction matches full rebuild on 1000 rows', () => {
  const dir = tmpdir();
  const base = [];
  for (let i = 1; i <= 900; i += 1) {
    base.push({
      id: `r${i}`,
      account: `acc${i % 50}`,
      amount: i % 97,
      category: `cat${i % 10}`,
      valid: i % 13 !== 0,
      corrects: null,
    });
  }
  const corrections = [];
  for (let i = 1; i <= 100; i += 1) {
    corrections.push({
      id: `c${i}`,
      account: `acc${i}`,
      amount: i * 2,
      category: `cat${i % 10}`,
      valid: true,
      corrects: `r${i}`,
    });
  }
  const inV1 = path.join(dir, 'v1.jsonl');
  const inV2 = path.join(dir, 'v2.jsonl');
  writeJsonl(inV1, base);
  writeJsonl(inV2, [...base, ...corrections]);

  const outV1 = path.join(dir, 'out-v1');
  assert.equal(run(['build', '--in', inV1, '--out', outV1]).status, 0);

  const outFull = path.join(dir, 'out-full');
  assert.equal(run(['build', '--in', inV2, '--out', outFull]).status, 0);

  const outIncr = path.join(dir, 'out-incr');
  const incr = run(['build', '--in', inV2, '--out', outIncr, '--incremental', '--prev', outV1]);
  assert.equal(incr.status, 0, incr.stderr);

  assert.deepEqual(readJson(path.join(outIncr, 'result.json')), readJson(path.join(outFull, 'result.json')));
  assert.deepEqual(readJson(path.join(outIncr, 'proof.json')), readJson(path.join(outFull, 'proof.json')));

  const verify = run(['verify', outIncr, path.join(outIncr, 'proof.json')]);
  assert.equal(verify.status, 0, verify.stderr);
});

test('D: all-NULL amounts and empty categories boundary', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'entries.jsonl');
  writeJsonl(input, [
    { id: 'n1', account: 'a1', amount: null, category: null, valid: true, corrects: null },
    { id: 'n2', account: 'a2', amount: null, category: '', valid: true, corrects: null },
    { id: 'n3', account: 'a3', amount: null, category: null, valid: false, corrects: null },
  ]);
  const out = path.join(dir, 'out');
  const build = run(['build', '--in', input, '--out', out]);
  assert.equal(build.status, 0, build.stderr);
  const result = readJson(path.join(out, 'result.json'));
  assert.deepEqual(result.categories, { '': { sum: 0, count: 2 } });
  const verify = run(['verify', out, path.join(out, 'proof.json')]);
  assert.equal(verify.status, 0, verify.stderr);
});

test('E_FUTURE_CORRECTION: correction pointing at a later/unknown id fails build', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'entries.jsonl');
  writeJsonl(input, [
    { id: 'e1', account: 'a1', amount: 10, category: 'food', valid: true, corrects: 'e9' },
    { id: 'e9', account: 'a1', amount: 20, category: 'food', valid: true, corrects: null },
  ]);
  const build = run(['build', '--in', input, '--out', path.join(dir, 'out')]);
  assert.notEqual(build.status, 0);
  assert.equal(build.status, 2);
  assert.match(build.stderr, /E_FUTURE_CORRECTION/);
});

test('stale certificate is rejected after input changes', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'entries.jsonl');
  const rows = [
    { id: 'e1', account: 'a1', amount: 100, category: 'food', valid: true, corrects: null },
  ];
  writeJsonl(input, rows);
  const out = path.join(dir, 'out');
  assert.equal(run(['build', '--in', input, '--out', out]).status, 0);

  // input evolves (a correction arrives) but the proof is not regenerated
  rows.push({ id: 'e2', account: 'a1', amount: 100, category: 'food', valid: true, corrects: 'e1' });
  fs.writeFileSync(path.join(out, 'input.snapshot.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const verify = run(['verify', out, path.join(out, 'proof.json')]);
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /E_PROOF/);
});

test('tampered result.json is rejected', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'entries.jsonl');
  writeJsonl(input, [
    { id: 'e1', account: 'a1', amount: 5, category: 'misc', valid: true, corrects: null },
  ]);
  const out = path.join(dir, 'out');
  assert.equal(run(['build', '--in', input, '--out', out]).status, 0);
  const resultPath = path.join(out, 'result.json');
  const result = readJson(resultPath);
  result.categories.misc.sum = 6;
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  const verify = run(['verify', out, path.join(out, 'proof.json')]);
  assert.notEqual(verify.status, 0);
  assert.match(verify.stderr, /E_PROOF/);
});
