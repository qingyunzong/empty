'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../cli');

function setup(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
  const input = path.join(dir, 'audit.jsonl');
  const store = path.join(dir, 'packs.log');
  fs.writeFileSync(input, lines.join('\n') + '\n');
  return { dir, input, store };
}

function runCli(input, store) {
  const out = [];
  const err = [];
  const status = execute(input, store, (l) => out.push(l), (l) => err.push(l));
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('CLI: SAT and UNSAT outputs on stdout, exit 0', () => {
  const { input, store } = setup([
    '{"cmd":"loadPack","name":"plc","version":1,"alphabet":["a","b"],"danger":"(a|b)*abb"}',
    '{"cmd":"setFilter","regex":"~((a|b)*aa(a|b)*)"}',
    '{"cmd":"check"}',
    '{"cmd":"setFilter","regex":"(a|b)* & ~((a|b)*abb)"}',
    '{"cmd":"check"}',
  ]);
  const res = runCli(input, store);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(out[2], { result: 'SAT', witness: 'abb', len: 3 });
  assert.equal(out[4].result, 'UNSAT');
  assert.equal(out[4].acceptCount, 0);
  assert.match(out[4].certHash, /^[0-9a-f]{16}$/);
  assert.ok(Number.isInteger(out[4].states));
});

test('CLI: complement without alphabet exits 5', () => {
  const { input, store } = setup([
    '{"cmd":"loadPack","name":"p","version":1,"danger":"a*"}',
    '{"cmd":"setFilter","regex":"~(a)"}',
    '{"cmd":"check"}',
  ]);
  const res = runCli(input, store);
  assert.equal(res.status, 5);
  assert.match(res.stderr, /COMPLEMENT_NO_ALPHABET/);
});

test('CLI: rollback to unknown pack exits 5', () => {
  const { input, store } = setup(['{"cmd":"rollback","name":"ghost","version":1}']);
  const res = runCli(input, store);
  assert.equal(res.status, 5);
  assert.match(res.stderr, /UNKNOWN_PACK/);
});

test('CLI: mid-file CRC corruption exits 5', () => {
  const { input, store } = setup([
    '{"cmd":"loadPack","name":"plc","version":1,"alphabet":["a","b"],"danger":"a*b"}',
    '{"cmd":"loadPack","name":"plc","version":2,"alphabet":["a","b"],"danger":"b*a"}',
    '{"cmd":"check"}',
  ]);
  // First run creates the store (check fails for lack of filter, ignore).
  runCli(input, store);
  // Corrupt a byte in the middle of the store file.
  const buf = fs.readFileSync(store);
  buf[20] = buf[20] === 65 ? 66 : 65;
  fs.writeFileSync(store, buf);
  const res = runCli(input, store);
  assert.equal(res.status, 5);
  assert.match(res.stderr, /CRC_FAILED/);
});

test('CLI: torn tail recovers to previous complete pack on restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
  const store = path.join(dir, 'packs.log');

  const step1 = path.join(dir, 'step1.jsonl');
  fs.writeFileSync(step1, [
    '{"cmd":"loadPack","name":"plc","version":1,"alphabet":["a","b"],"danger":"a*b"}',
    '{"cmd":"loadPack","name":"plc","version":2,"alphabet":["a","b"],"danger":"(a|b)*a"}',
  ].join('\n') + '\n');
  assert.equal(runCli(step1, store).status, 0);

  // Crash mid-append of a third record.
  const half = JSON.stringify({ crc: 'deadbeef', data: { type: 'loadPack', name: 'plc', version: 3, danger: 'b' } });
  fs.appendFileSync(store, half.slice(0, half.length / 2));

  // Restart: a check must use version 2's danger pattern.
  const step2 = path.join(dir, 'step2.jsonl');
  fs.writeFileSync(step2, [
    '{"cmd":"setFilter","regex":"a"}',
    '{"cmd":"check"}',
  ].join('\n') + '\n');
  const res = runCli(step2, store);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.trim().split('\n').map(JSON.parse);
  // version 2 danger is (a|b)*a, so filter "a" is SAT with witness "a";
  // had the torn v3 record (danger "b") survived, this would be UNSAT.
  assert.deepEqual(out[1], { result: 'SAT', witness: 'a', len: 1 });
});

test('CLI: rollback to previous version changes check outcome', () => {
  const { input, store } = setup([
    '{"cmd":"loadPack","name":"plc","version":1,"alphabet":["a","b"],"danger":"a+"}',
    '{"cmd":"loadPack","name":"plc","version":2,"alphabet":["a","b"],"danger":"b+"}',
    '{"cmd":"rollback","name":"plc","version":1}',
    '{"cmd":"setFilter","regex":"a(a|b)*"}',
    '{"cmd":"check"}',
  ]);
  const res = runCli(input, store);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(out[2], { result: 'rolledBack', name: 'plc', version: 1 });
  assert.deepEqual(out[4], { result: 'SAT', witness: 'a', len: 1 });
});
