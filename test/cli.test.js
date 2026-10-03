import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';

function setup(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cli-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { dir, inDir, outDir };
}

function runCli(args) {
  const captured = { stdout: '', stderr: '' };
  const io = {
    stdout: { write: (s) => { captured.stdout += s; } },
    stderr: { write: (s) => { captured.stderr += s; } },
  };
  const status = main(args, io);
  return { status, ...captured };
}

function readJsonl(file) {
  const body = fs.readFileSync(file, 'utf8').trim();
  return body === '' ? [] : body.split('\n').map((l) => JSON.parse(l));
}

test('CLI certify writes certs.jsonl, void.jsonl and late.log', () => {
  const { inDir, outDir } = setup([
    '{"type":"calib","id":"c1","eventTs":1000,"tool":"T1","ok":true,"validFrom":0,"validTo":40000,"op":"qa"}',
    '{"type":"torque","id":"t1","eventTs":10000,"bolt":"B1","tool":"T1","peak":12.5,"angle":90,"op":"alice"}',
    '{"type":"torque","id":"t9","eventTs":30000,"bolt":"B9","tool":"T1","peak":11,"angle":80,"op":"bob"}',
    '{"type":"scan","id":"s9","eventTs":30000,"bolt":"B9","lot":"L9","op":"bob"}',
    '{"type":"scan","id":"s1","eventTs":10300,"bolt":"B1","lot":"L1","op":"alice"}',
    '{"type":"retract","eventTs":35000,"kind":"calib","id":"c1"}',
  ]);
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^certify: events=6 /);

  const certs = readJsonl(path.join(outDir, 'certs.jsonl'));
  const voids = readJsonl(path.join(outDir, 'void.jsonl'));
  const late = readJsonl(path.join(outDir, 'late.log'));

  const b1 = certs.filter((r) => r.bolt === 'B1');
  assert.deepEqual(b1.map((r) => [r.version, r.status]), [[1, 'HOLD'], [2, 'OK']]);
  assert.equal(b1[1].lot, 'L1');

  assert.equal(voids.length, 2); // B1 and B9 both cascade to VOID
  assert.ok(voids.every((v) => v.reasons.includes('CALIB_RETRACTED')));

  assert.equal(late.length, 1);
  assert.equal(late[0].id, 's1');
});

test('CLI reports DUP_EVENT and exits non-zero on conflicting ids', () => {
  const { inDir, outDir } = setup([
    '{"type":"torque","id":"t1","eventTs":10000,"bolt":"B1","tool":"T1","peak":10,"angle":90}',
    '{"type":"torque","id":"t1","eventTs":10000,"bolt":"B1","tool":"T1","peak":10,"angle":91}',
  ]);
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /DUP_EVENT/);
});

test('CLI reports ANGLE_RANGE on stderr but still certifies valid bolts', () => {
  const { inDir, outDir } = setup([
    '{"type":"calib","id":"c1","eventTs":1000,"tool":"T1","ok":true,"validFrom":0,"validTo":30000}',
    '{"type":"torque","id":"t1","eventTs":10000,"bolt":"B1","tool":"T1","peak":10,"angle":90}',
    '{"type":"scan","id":"s1","eventTs":10100,"bolt":"B1","lot":"L1"}',
    '{"type":"torque","id":"t2","eventTs":11000,"bolt":"B1","tool":"T1","peak":10,"angle":9999}',
  ]);
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /ANGLE_RANGE/);
  const certs = readJsonl(path.join(outDir, 'certs.jsonl'));
  const final = certs.filter((r) => r.bolt === 'B1').at(-1);
  assert.equal(final.status, 'OK');
  assert.equal(final.torqueId, 't1'); // bad-angle tightening never wins
});

test('CLI rejects missing --in/--out with usage error', () => {
  const res = runCli(['certify']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /BAD_ARGS/);
});

test('CLI reads every .jsonl file in --in directory in sorted order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cli-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(path.join(inDir, '02-scan.jsonl'),
    '{"type":"scan","id":"s1","eventTs":10100,"bolt":"B1","lot":"L1"}\n');
  fs.writeFileSync(path.join(inDir, '01-tighten.jsonl'),
    '{"type":"calib","id":"c1","eventTs":1000,"tool":"T1","ok":true,"validFrom":0,"validTo":30000}\n' +
    '{"type":"torque","id":"t1","eventTs":10000,"bolt":"B1","tool":"T1","peak":10,"angle":90}\n');
  fs.writeFileSync(path.join(inDir, 'notes.txt'), 'ignored\n');
  const res = runCli(['certify', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 0, res.stderr);
  const certs = readJsonl(path.join(outDir, 'certs.jsonl'));
  assert.deepEqual(certs.map((r) => r.status), ['HOLD', 'OK']);
});
