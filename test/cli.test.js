'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeFrame, FrameParser, FrameError } = require('../src/frame');
const { buildFrames } = require('./helpers');
const { run } = require('../cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-'));
}

function runCli(args, dir) {
  const stdout = [];
  const stderr = [];
  const status = run(args, { out: (l) => stdout.push(l), err: (l) => stderr.push(l), dataDir: dir });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('frame parser tolerates arbitrary fragmentation', () => {
  const { frames } = buildFrames([
    { actor: 'a', cmd: 'set', args: { key: 'x', value: 1 } },
    { actor: 'b', cmd: 'inc', args: { key: 'y', n: 2 } },
  ]);
  const blob = Buffer.concat(frames.map(encodeFrame));
  for (const chunkSize of [1, 3, 7, 64, blob.length]) {
    const parser = new FrameParser();
    const out = [];
    for (let i = 0; i < blob.length; i += chunkSize) out.push(...parser.push(blob.subarray(i, i + chunkSize)));
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].frame, frames[0]);
    assert.equal(parser.pendingBytes, 0);
  }
});

test('crc corruption is a frame error', () => {
  const { frames } = buildFrames([{ actor: 'a', cmd: 'set', args: { key: 'x', value: 1 } }]);
  const bad = Buffer.from(encodeFrame(frames[0]));
  bad[bad.length - 1] ^= 0xff;
  const parser = new FrameParser();
  assert.throws(() => parser.push(bad), FrameError);
});

test('cli: frame error exits 2', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'bad.bin');
  fs.writeFileSync(f, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  const r = runCli([f], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /error:/);
});

test('cli: expired lease exits 3 and keeps evidence', () => {
  const dir = tmpdir();
  const { frames } = buildFrames([
    { actor: 'alice', cmd: 'set', args: { key: 'x', value: 1 } },
    { actor: 'bob', cmd: 'set', args: { key: 'y', value: 2 }, leaseUntil: 0 }, // expires at clock 1
  ]);
  const f = path.join(dir, 'frames.bin');
  fs.writeFileSync(f, Buffer.concat(frames.map(encodeFrame)));
  const r = runCli([f], dir);
  assert.equal(r.status, 3, r.stderr);
  const lines = r.stdout.trim().split('\n').map(JSON.parse);
  const rejected = lines.find((l) => l.status === 'rejected');
  assert.match(rejected.reason, /lease-expired/);
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].reason.startsWith('lease-expired'), true);
  assert.ok(evidence[0].frameHash);
  // the rejected write is NOT in the log
  const summary = lines[lines.length - 1];
  assert.equal(summary.count, 1);
});

test('cli: run then verify checkpoint; tampered log exits 5', () => {
  const dir = tmpdir();
  const { frames } = buildFrames([
    { actor: 'alice', cmd: 'set', args: { key: 'x', value: 1 } },
    { actor: 'bob', cmd: 'inc', args: { key: 'n', n: 5 } },
  ]);
  const f = path.join(dir, 'frames.bin');
  fs.writeFileSync(f, Buffer.concat(frames.map(encodeFrame)));
  const r1 = runCli([f], dir);
  assert.equal(r1.status, 0, r1.stderr);
  const ck = path.join(dir, 'checkpoint.json');
  const r2 = runCli(['verify', ck], dir);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(r2.stdout).ok, true);

  // tamper with the log -> chain break -> exit 5
  const log = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  fs.writeFileSync(path.join(dir, 'audit.log'), log.replace('"value":1', '"value":2'));
  const r3 = runCli(['verify', ck], dir);
  assert.equal(r3.status, 5);
  assert.match(r3.stderr, /chain break/);
});

test('cli: checkpoint sig tamper exits 5', () => {
  const dir = tmpdir();
  const { frames } = buildFrames([{ actor: 'a', cmd: 'set', args: { key: 'x', value: 1 } }]);
  const f = path.join(dir, 'frames.bin');
  fs.writeFileSync(f, Buffer.concat(frames.map(encodeFrame)));
  assert.equal(runCli([f], dir).status, 0);
  const ckPath = path.join(dir, 'checkpoint.json');
  const ck = JSON.parse(fs.readFileSync(ckPath, 'utf8'));
  ck.count = 99;
  const forged = path.join(dir, 'forged.json');
  fs.writeFileSync(forged, JSON.stringify(ck));
  const r = runCli(['verify', forged], dir);
  assert.equal(r.status, 5);
});
