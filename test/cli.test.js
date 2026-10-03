'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-merge-'));
}

function write(dir, name, lines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines);
  return p;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI merges clean inputs and writes sorted result plus empty conflicts', () => {
  const dir = tmpdir();
  const base = write(dir, 'base.jsonl', [
    '{"id":2,"account":"a2","amount":20,"ccy":"USD","seq":2,"status":"DRAFT"}',
    '{"id":1,"account":"a1","amount":10,"ccy":"USD","seq":1,"status":"DRAFT"}',
  ]);
  const left = write(dir, 'left.jsonl', [
    '{"id":2,"account":"a2","amount":20,"ccy":"USD","seq":2,"status":"LOCKED"}',
    '{"id":1,"account":"a1","amount":10,"ccy":"USD","seq":1,"status":"DRAFT"}',
  ]);
  const right = write(dir, 'right.jsonl', [
    '{"id":2,"account":"a2","amount":20,"ccy":"USD","seq":2,"status":"DRAFT"}',
    '{"id":1,"account":"a1","amount":99,"ccy":"USD","seq":1,"status":"DRAFT"}',
  ]);
  const out = path.join(dir, 'result.jsonl');
  const conflicts = path.join(dir, 'conflicts.json');
  const res = runCli(['merge', base, left, right, '--out', out, '--conflicts', conflicts]);
  assert.equal(res.status, 0, res.stderr);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((r) => r.id), [1, 2]);
  assert.equal(lines[0].amount, 99);
  assert.equal(lines[1].status, 'LOCKED');
  assert.deepEqual(JSON.parse(fs.readFileSync(conflicts, 'utf8')), []);
});

test('CLI writes conflict entries with sha256 certificate', () => {
  const dir = tmpdir();
  const base = write(dir, 'base.jsonl', '{"id":1,"amount":10,"status":"DRAFT"}');
  const left = write(dir, 'left.jsonl', '{"id":1,"amount":11,"status":"DRAFT"}');
  const right = write(dir, 'right.jsonl', '{"id":1,"amount":12,"status":"DRAFT"}');
  const out = path.join(dir, 'result.jsonl');
  const conflicts = path.join(dir, 'conflicts.json');
  const res = runCli(['merge', base, left, right, '--out', out, '--conflicts', conflicts]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), '');
  const list = JSON.parse(fs.readFileSync(conflicts, 'utf8'));
  assert.equal(list.length, 1);
  assert.equal(list[0].rule, 'R1');
  assert.match(list[0].sha256, /^[0-9a-f]{64}$/);
});

test('CLI reports bad JSONL line with {code,line,msg} and exit 2', () => {
  const dir = tmpdir();
  const base = write(dir, 'base.jsonl', '{"id":1}\n{bad json}\n');
  const left = write(dir, 'left.jsonl', '{"id":1}');
  const right = write(dir, 'right.jsonl', '{"id":1}');
  const res = runCli(['merge', base, left, right]);
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr.trim().split('\n')[0]);
  assert.equal(err.code, 'BAD_JSONL');
  assert.equal(err.line, 2);
  assert.ok(err.msg.includes('base.jsonl'));
});

test('CLI reports duplicate id with exit 2', () => {
  const dir = tmpdir();
  const base = write(dir, 'base.jsonl', '{"id":1}');
  const left = write(dir, 'left.jsonl', '{"id":7}\n{"id":7}');
  const right = write(dir, 'right.jsonl', '{"id":1}');
  const res = runCli(['merge', base, left, right]);
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr.trim().split('\n')[0]);
  assert.equal(err.code, 'DUP_ID');
  assert.equal(err.line, 2);
});

test('CLI reports illegal status transition target with exit 2', () => {
  const dir = tmpdir();
  const base = write(dir, 'base.jsonl', '{"id":1,"status":"DRAFT"}');
  const left = write(dir, 'left.jsonl', '{"id":1,"status":"DRAFT"}');
  const right = write(dir, 'right.jsonl', '{"id":1,"status":"ARCHIVED"}');
  const res = runCli(['merge', base, left, right]);
  assert.equal(res.status, 2);
  const err = JSON.parse(res.stderr.trim().split('\n')[0]);
  assert.equal(err.code, 'INVALID_STATUS');
  assert.equal(err.line, 1);
});

test('CLI rejects bad usage with exit 2', () => {
  const res = runCli(['merge', 'only-one.jsonl']);
  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes('Usage'));
});
