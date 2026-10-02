import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, writeScript } from '../support/helpers.js';

const SCRIPT = `
line A
calendar A { shift 08:00-16:00 }
job J1 { duration 30m priority 1 }
commit
`;

function storeWithCommit() {
  const dir = tmpdir();
  runCli(['init', dir]);
  const r = runCli(['apply', dir, writeScript(dir, SCRIPT)]);
  assert.equal(r.code, 0);
  return dir;
}

function flipBytes(file) {
  const buf = fs.readFileSync(file);
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fs.writeFileSync(file, buf);
}

test('corrupt state.json checksum -> RECOVERY_ERROR, exit 3', () => {
  const dir = storeWithCommit();
  flipBytes(path.join(dir, 'state.json'));
  for (const cmd of ['recover', 'export']) {
    const r = runCli([cmd, dir]);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /RECOVERY_ERROR/);
  }
});

test('corrupt checkpoint.json checksum -> RECOVERY_ERROR, exit 3', () => {
  const dir = storeWithCommit();
  flipBytes(path.join(dir, 'checkpoint.json'));
  const r = runCli(['recover', dir]);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /RECOVERY_ERROR/);
});

test('corrupt WAL tail is ignored, recovery succeeds', () => {
  const dir = storeWithCommit();
  fs.appendFileSync(path.join(dir, 'wal.log'), 'this is not json\n{"payload":{},"sum":"bad"}\n');
  const r = runCli(['recover', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RECOVERED gen=1 jobs=1/);
});

test('corrupt WAL commit record is treated as invalid tail', () => {
  const dir = storeWithCommit();
  // hand-craft a commit record, then corrupt it: recovery must stay at gen=1
  const rec = JSON.stringify({ payload: { type: 'commit', seq: 2, snapshot: { env: {}, jobs: [] } }, sum: 'deadbeef' });
  fs.appendFileSync(path.join(dir, 'wal.log'), rec + '\n');
  const r = runCli(['recover', dir]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RECOVERED gen=1 jobs=1/);
});

test('missing state.json -> RECOVERY_ERROR', () => {
  const dir = storeWithCommit();
  fs.unlinkSync(path.join(dir, 'state.json'));
  const r = runCli(['recover', dir]);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /RECOVERY_ERROR/);
});
