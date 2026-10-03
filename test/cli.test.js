import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { tmpdir } from './helpers.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// in-process through runCli (the bin wrapper is a thin process.exit shim).
function run(dir, args) {
  const result = { stdout: '', stderr: '' };
  const code = runCli(['--dir', dir, ...args], {
    out: (s) => { result.stdout += `${s}\n`; },
    err: (s) => { result.stderr += `${s}\n`; },
  });
  result.code = code;
  if (result.stdout) result.out = JSON.parse(result.stdout);
  return result;
}

function writeJson(dir, name, obj) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('CLI end-to-end: add/derive/revoke/restore/status/snapshot/verifylog', () => {
  const dir = tmpdir();
  const f1 = writeJson(dir, 'f1.json', { id: 'f1', source: 's1', value: 2 });
  const f2 = writeJson(dir, 'f2.json', { id: 'f2', source: 's2', value: 3 });
  const rule = writeJson(dir, 'd1.json', { id: 'd1', op: 'sum', min: 5, inputs: ['f1', 'f2'] });

  assert.equal(run(dir, ['add', f1]).out.ok, true);
  assert.equal(run(dir, ['add', f2]).out.ok, true);
  assert.equal(run(dir, ['derive', rule]).out.ok, true);
  assert.equal(run(dir, ['status', 'd1']).out.status, 'valid');

  run(dir, ['revoke', 's2']);
  const degraded = run(dir, ['status', 'd1']).out;
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.support, 2);

  run(dir, ['restore', 's2']);
  assert.equal(run(dir, ['status', 'd1']).out.status, 'valid');

  const snap = run(dir, ['snapshot']).out;
  assert.equal(snap.ok, true);
  const verify = run(dir, ['verifylog']).out;
  assert.equal(verify.ok, true);
  assert.equal(verify.events, 5);
  assert.equal(verify.snapshotSeq, 5);
});

test('CLI exit codes: E_CYCLE=2, E_SOURCE_GONE=3, E_HASH=5', () => {
  const dir = tmpdir();
  const selfLoop = writeJson(dir, 'loop.json', { id: 'x', op: 'count', inputs: ['x'] });
  const cyc = run(dir, ['derive', selfLoop]);
  assert.equal(cyc.code, 2);
  assert.match(cyc.stderr, /E_CYCLE/);

  const gone = run(dir, ['revoke', 'ghost']);
  assert.equal(gone.code, 3);
  assert.match(gone.stderr, /E_SOURCE_GONE/);

  // corrupt the WAL, then any command surfaces E_HASH
  const f = writeJson(dir, 'f.json', { id: 'f1', source: 's1' });
  run(dir, ['add', f]);
  const wal = path.join(dir, 'wal.log');
  const ev = JSON.parse(fs.readFileSync(wal, 'utf8').trim());
  ev.payload.id = 'tampered';
  fs.writeFileSync(wal, `${JSON.stringify(ev)}\n`);
  const tampered = run(dir, ['verifylog']);
  assert.equal(tampered.code, 5);
  assert.match(tampered.stderr, /E_HASH/);
});

test('CLI remove: deleted facts stay deleted across restore', () => {
  const dir = tmpdir();
  const f = writeJson(dir, 'f.json', { id: 'f1', source: 's1' });
  const rule = writeJson(dir, 'd.json', { id: 'd1', op: 'count', inputs: ['f1'] });
  run(dir, ['add', f]);
  run(dir, ['derive', rule]);
  run(dir, ['revoke', 's1']);
  run(dir, ['remove', 'f1']);
  run(dir, ['restore', 's1']);
  assert.equal(run(dir, ['status', 'f1']).out.status, 'deleted');
  assert.equal(run(dir, ['status', 'd1']).out.status, 'degraded');
});
