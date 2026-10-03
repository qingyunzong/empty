'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pallet-cli-'));
}

let outCounter = 0;

function run(dir, args, env = {}) {
  // This sandbox cannot pipe child stdout back (spawn EPERM), so capture
  // via a temp file instead.
  const outFile = path.join(os.tmpdir(), `pallet-cli-out-${process.pid}-${outCounter++}.txt`);
  const fd = fs.openSync(outFile, 'w');
  const res = spawnSync(process.execPath, [CLI, dir, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  const stdout = fs.readFileSync(outFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  return { status: res.status, json: JSON.parse(stdout.trim().split('\n').pop()) };
}

test('cli: put/transfer/state roundtrip with JSON output', () => {
  const dir = tmpdir();
  let r = run(dir, ['put', '{"pallet":"P1","lot":"L1","quarantine":true}']);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  r = run(dir, ['put', '{"pallet":"P1","lot":"L2"}']);
  assert.equal(r.status, 0);
  r = run(dir, ['transfer', '{"from":"P1","to":"P2","lots":["L1","L2"],"quarantine":false}']);
  assert.equal(r.status, 0);
  r = run(dir, ['state']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.state, {
    pallets: { P2: { L1: { quarantine: false }, L2: { quarantine: false } } },
  });
  r = run(dir, ['index']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.index, [
    { pallet: 'P2', lot: 'L1', quarantine: false },
    { pallet: 'P2', lot: 'L2', quarantine: false },
  ]);
});

test('cli: business errors exit 1', () => {
  const dir = tmpdir();
  run(dir, ['put', '{"pallet":"P1","lot":"L1"}']);
  let r = run(dir, ['put', '{"pallet":"P1","lot":"L1"}']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'E_DUP');

  r = run(dir, ['transfer', '{"from":"P1","to":"P2","lots":["NOPE"]}']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'E_NOT_FOUND');

  r = run(dir, ['transfer', 'not-json']);
  assert.equal(r.status, 1);
  assert.equal(r.json.error.code, 'E_ARG');
});

test('cli: crash simulation via PALLET_CRASH_AT, recovery on next open', () => {
  const dir = tmpdir();
  run(dir, ['put', '{"pallet":"P1","lot":"L1"}']);
  run(dir, ['put', '{"pallet":"P1","lot":"L2"}']);

  let r = run(dir, ['transfer', '{"from":"P1","to":"P2","lots":["L1","L2"],"quarantine":true}'], {
    PALLET_CRASH_AT: 'after_records',
  });
  assert.equal(r.status, 70);
  assert.equal(r.json.error.code, 'E_CRASH');
  r = run(dir, ['state']);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.state, {
    pallets: { P1: { L1: { quarantine: false }, L2: { quarantine: false } } },
  });

  r = run(dir, ['transfer', '{"from":"P1","to":"P2","lots":["L1","L2"],"quarantine":true}'], {
    PALLET_CRASH_AT: 'after_commit',
  });
  assert.equal(r.status, 70);
  r = run(dir, ['state']);
  assert.deepEqual(r.json.state, {
    pallets: { P2: { L1: { quarantine: true }, L2: { quarantine: true } } },
  });
});

test('cli: corrupted wal exits 2, torn tail is tolerated', () => {
  const dir = tmpdir();
  run(dir, ['put', '{"pallet":"P1","lot":"L1"}']);
  run(dir, ['put', '{"pallet":"P1","lot":"L2"}']);
  const walPath = path.join(dir, 'wal.log');

  // Torn tail: partial last line is truncated, state still readable.
  fs.appendFileSync(walPath, '{"t":"rec","tx":99,"op":');
  let r = run(dir, ['state']);
  assert.equal(r.status, 0);
  assert.equal(r.json.state.pallets.P1.L1.quarantine, false);

  // Corruption in the middle: checksum mismatch -> exit 2.
  const lines = fs.readFileSync(walPath, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.cksum = 'deadbeefdeadbeef';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(walPath, lines.join('\n') + '\n');
  r = run(dir, ['state']);
  assert.equal(r.status, 2);
  assert.equal(r.json.error.code, 'E_CORRUPT');
});
