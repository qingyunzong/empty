import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { canonical } from '../src/hash.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const CRASH_EXIT = 99;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qcl-test-'));
}
// Sandboxed offline runs cannot pipe child stdout/stderr; the CLI mirrors
// them to QCL_OUT / QCL_ERR files instead.
function run(dir, args, env = {}) {
  const outFile = path.join(dir, '.out.log');
  const errFile = path.join(dir, '.err.log');
  const r = spawnSync(process.execPath, [CLI, `--dir=${dir}`, ...args], {
    env: {
      ...process.env, ...env, QCL_OUT: outFile, QCL_ERR: errFile,
    },
    encoding: 'utf8',
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const out = read(outFile).trim();
  const err = read(errFile).trim();
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { code: r.status, out, err };
}
function json(r) {
  return JSON.parse(r.out);
}

test('acceptance 1a: crash at wal-append -> torn tail truncated, WAL replayed', () => {
  const dir = tmpdir();
  const first = json(run(dir, ['open', 'd1']));
  assert.equal(run(dir, ['open', 'd2'], { QCL_CRASH_AT: 'wal-append' }).code, CRASH_EXIT);

  const rec = json(run(dir, ['crash-recover']));
  assert.deepEqual(rec.recovered.faults, ['wal-append']);
  assert.match(rec.recovered.actions[0], /truncated torn WAL tail/);

  const v = json(run(dir, ['verify']));
  assert.equal(v.hash, first.hash); // d2 lost (never fsynced), d1 intact
  assert.equal(v.seq, 1);
  // WAL is clean again: subsequent mutations work
  assert.equal(run(dir, ['open', 'd3']).code, 0);
});

test('acceptance 1b: crash at snapshot-rename -> half snapshot ignored', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['rework', 'r1', 'd1']);
  const crash = run(dir, ['close', 'r1', '--result=pass'], { QCL_CRASH_AT: 'snapshot-rename' });
  assert.equal(crash.code, CRASH_EXIT);
  assert.ok(fs.existsSync(path.join(dir, 'snapshot.json.tmp')), 'half snapshot left behind');
  assert.ok(!fs.existsSync(path.join(dir, 'snapshot.json')));

  const rec = json(run(dir, ['crash-recover']));
  assert.ok(rec.recovered.faults.includes('snapshot-rename'));
  assert.ok(rec.recovered.actions.some((a) => /ignored half snapshot/.test(a)));
  assert.ok(!fs.existsSync(path.join(dir, 'snapshot.json.tmp')), 'half snapshot discarded');

  const v = json(run(dir, ['verify']));
  assert.equal(v.seq, 3);
  assert.deepEqual(v.index.defectsByStatus, { closed: 1 }); // close survived via WAL
});

test('acceptance 1c: crash at index-update -> index rebuilt, no double count', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  const crash = run(dir, ['open', 'd2'], { QCL_CRASH_AT: 'index-update' });
  assert.equal(crash.code, CRASH_EXIT);
  const corrupt = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.equal(corrupt.defectsByStatus.open, 4); // doubled by the fault

  const rec = json(run(dir, ['crash-recover']));
  assert.ok(rec.recovered.faults.includes('index-update'));
  assert.ok(rec.recovered.actions.some((a) => /no double count/.test(a)));

  const v = json(run(dir, ['verify']));
  assert.deepEqual(v.index.defectsByStatus, { open: 2 }); // exactly two defects
  assert.equal(v.index.seq, 2);
});

test('exit 22: WAL checksum failure mid-file', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['open', 'd2']);
  const wal = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(wal, 'utf8').split('\n');
  lines[0] = lines[0].replace('d1', 'd9'); // corrupt first record, crc now invalid
  fs.writeFileSync(wal, lines.join('\n'));
  const rec = run(dir, ['crash-recover']);
  assert.equal(rec.code, 22);
  assert.match(rec.err, /checksum failure/);
  assert.equal(run(dir, ['verify']).code, 22);
});

test('exit 23: state hash mismatch (tampered op, crc repaired)', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['open', 'd2']);
  const wal = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(wal, 'utf8').split('\n').filter(Boolean);
  const rec0 = JSON.parse(lines[0]);
  rec0.op.defectId = 'd9'; // tamper payload, keep original hash
  rec0.crc = crc32(Buffer.from(
    canonical({ seq: rec0.seq, op: rec0.op, hash: rec0.hash }), 'utf8',
  )).toString(16).padStart(8, '0');
  lines[0] = JSON.stringify(rec0);
  fs.writeFileSync(wal, `${lines.join('\n')}\n`);
  const rec = run(dir, ['crash-recover']);
  assert.equal(rec.code, 23);
  assert.match(rec.err, /hash mismatch/);
  assert.equal(run(dir, ['verify']).code, 23);
});

test('exit 21: undo after close via CLI', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['rework', 'r1', 'd1']);
  run(dir, ['close', 'r1', '--result=pass']);
  const undoClose = run(dir, ['undo', 'n3']);
  assert.equal(undoClose.code, 21);
  const undoOpen = run(dir, ['undo', 'n1']); // defect loop already closed
  assert.equal(undoOpen.code, 21);
});

test('acceptance 2 (CLI): scrap tombstone blocks rework and reopen', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['rework', 'r1', 'd1']);
  run(dir, ['close', 'r1', '--result=scrap']);
  const revive = run(dir, ['rework', 'r2', 'd1']);
  assert.equal(revive.code, 1);
  assert.match(revive.err, /tombstone/);
  const reopen = run(dir, ['open', 'd1']);
  assert.equal(reopen.code, 1);
  assert.match(reopen.err, /tombstone/);
  const v = json(run(dir, ['verify']));
  assert.deepEqual(v.index.defectsByStatus, { scrapped: 1 });
});

test('acceptance 3 (CLI): correction reports impact set of affected sequence only', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['open', 'd2']);
  run(dir, ['rework', 'r1', 'd1']);
  run(dir, ['close', 'r1', '--result=fail']);
  run(dir, ['rework', 'r2', 'd1']);
  run(dir, ['close', 'r2', '--result=pass']);
  run(dir, ['rework', 'r3', 'd2']);
  run(dir, ['close', 'r3', '--result=pass']);
  const corr = json(run(dir, ['correct', 'r1', '--result=pass']));
  assert.deepEqual(corr.impactSet, ['n5', 'n6']);
  const state = json(run(dir, ['state']));
  assert.equal(state.defects.d1.status, 'closed');
  assert.equal(state.defects.d2.status, 'closed');
  assert.equal(run(dir, ['verify']).code, 0);
});

test('undo pre-close via CLI leaves audit and keeps verify green', () => {
  const dir = tmpdir();
  run(dir, ['open', 'd1']);
  run(dir, ['open', 'd2']);
  run(dir, ['rework', 'r1', 'd2']);
  const undo = json(run(dir, ['undo', 'n3', '--reason=wrong-defect']));
  assert.equal(undo.ok, true);
  const state = json(run(dir, ['state']));
  assert.equal(state.defects.d2.status, 'open');
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].reason, 'wrong-defect');
  assert.equal(run(dir, ['verify']).code, 0);
});
