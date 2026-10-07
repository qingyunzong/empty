'use strict';

// End-to-end CLI tests: output shapes and exit code 5 error paths.
// (The sandbox blocks grandchild processes, so the command stream is driven
// through lib/runner.js — the same code path cli.js uses.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pack = require('../lib/pack');
const { runAudit } = require('../lib/runner');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
}

test('full audit session: SAT, UNSAT certificate, rollback', () => {
  const dir = tmpdir();
  const packFile = path.join(dir, 'rules.pack');
  pack.appendPack(packFile, [
    { id: 'danger-overflow', pattern: '(a|b)*aa(a|b)*', alphabet: ['a', 'b'] },
  ]);
  pack.appendPack(packFile, [
    { id: 'danger-overflow', pattern: '(a|b)*aa(a|b)*', filter: 'b(a|b)*', alphabet: ['a', 'b'] },
  ]);

  const res = runAudit([
    JSON.stringify({ op: 'loadPack', path: packFile }),
    JSON.stringify({ op: 'check' }),
    JSON.stringify({ op: 'rollback', version: 1 }),
    JSON.stringify({ op: 'check' }),
  ]);

  assert.equal(res.exitCode, 0, res.stderr.join('\n'));
  const out = res.stdout;
  assert.match(out[0], /^PACK\{"path":.*"versions":2,"current":2,"truncated":false\}$/);
  // v2 rule: words starting with b that contain aa -> shortest is "baa".
  assert.equal(out[1], 'danger-overflow SAT{"witness":"baa","len":3}');
  assert.match(out[2], /^ROLLBACK\{"version":1\}$/);
  // v1 rule has no filter: shortest word containing aa is "aa".
  assert.equal(out[3], 'danger-overflow SAT{"witness":"aa","len":2}');
});

test('UNSAT output carries certHash and states', () => {
  const dir = tmpdir();
  const packFile = path.join(dir, 'rules.pack');
  pack.appendPack(packFile, [
    { id: 'impossible', pattern: '(a|b)*', filter: '~((a|b)*)', alphabet: ['a', 'b'] },
  ]);
  const res = runAudit([
    JSON.stringify({ op: 'loadPack', path: packFile }),
    JSON.stringify({ op: 'check' }),
  ]);
  assert.equal(res.exitCode, 0, res.stderr.join('\n'));
  const m = res.stdout[1].match(/^impossible UNSAT\{"certHash":"([0-9a-f]{64})","states":(\d+)\}$/);
  assert.ok(m, res.stdout[1]);
  assert.ok(Number(m[2]) >= 1);
});

test('complement without an explicit alphabet exits with code 5', () => {
  const res = runAudit([JSON.stringify({ op: 'check', pattern: '~(a*)' })]);
  assert.equal(res.exitCode, 5);
  assert.match(res.stderr[0], /COMPLEMENT_NO_ALPHABET/);
});

test('unknown pack exits with code 5', () => {
  const dir = tmpdir();
  const res = runAudit([
    JSON.stringify({ op: 'loadPack', path: path.join(dir, 'nope.pack') }),
  ]);
  assert.equal(res.exitCode, 5);
  assert.match(res.stderr[0], /UNKNOWN_PACK/);
});

test('rollback to a nonexistent version exits with code 5', () => {
  const dir = tmpdir();
  const packFile = path.join(dir, 'rules.pack');
  pack.appendPack(packFile, [{ id: 'r', pattern: 'a', alphabet: ['a'] }]);
  const res = runAudit([
    JSON.stringify({ op: 'loadPack', path: packFile }),
    JSON.stringify({ op: 'rollback', version: 7 }),
  ]);
  assert.equal(res.exitCode, 5);
  assert.match(res.stderr[0], /UNKNOWN_VERSION/);
});

test('CRC failure exits with code 5', () => {
  const dir = tmpdir();
  const packFile = path.join(dir, 'rules.pack');
  pack.appendPack(packFile, [{ id: 'r', pattern: 'a', alphabet: ['a'] }]);
  const buf = fs.readFileSync(packFile);
  buf[15] = buf[15] === 65 ? 66 : 65;
  fs.writeFileSync(packFile, buf);
  const res = runAudit([JSON.stringify({ op: 'loadPack', path: packFile })]);
  assert.equal(res.exitCode, 5);
  assert.match(res.stderr[0], /CRC_FAILED/);
});

test('malformed command line exits with code 4', () => {
  const res = runAudit(['{not json']);
  assert.equal(res.exitCode, 4);
  assert.match(res.stderr[0], /BAD_JSON/);
});
