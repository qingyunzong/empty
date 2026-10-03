'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGateway } = require('../lib/run');
const { TYPE, encodeFrame } = require('../lib/frame');

function run(framesOrBuffer, args = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cli-'));
  const input = path.join(dir, 'frames.bin');
  fs.writeFileSync(input, Buffer.isBuffer(framesOrBuffer) ? framesOrBuffer : Buffer.concat(framesOrBuffer));
  let stdout = '';
  let stderr = '';
  const code = runGateway({
    input, fresh: true,
    write: (s) => { stdout += s; },
    errWrite: (s) => { stderr += s; },
    ...args,
  });
  return { code, stdout, stderr, input };
}

const F = (type, member, reqId, amount, seq, tick) => encodeFrame({ type, member, reqId, amount, seq, tick });

test('clean run exits 0 and prints one line per request plus a summary', () => {
  const res = run([
    F(TYPE.RESERVE, 'alice', 1, 100, 1, 0),
    F(TYPE.COMMIT, 'alice', 1, 100, 2, 1),
  ], { budget: 500 });
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /type=reserve .* status=accept granted=100 remaining=400 merkle=[0-9a-f]{64}/);
  assert.match(lines[1], /type=commit .* status=accept committed=100 remaining=400/);
  assert.match(lines[2], /^summary requests=2 used=100 reserved=0 remaining=400 merkle=[0-9a-f]{64}$/);
});

test('corrupt frame exits 2', () => {
  const bad = Buffer.from(F(TYPE.RESERVE, 'alice', 1, 100, 1, 0));
  bad[18] ^= 0x01; // flip a bit inside amount -> crc mismatch
  const res = run(bad);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /corrupt frame/);
});

test('truncated stream exits 2', () => {
  const res = run(F(TYPE.RESERVE, 'alice', 1, 100, 1, 0).subarray(0, 20));
  assert.equal(res.code, 2);
});

test('reserve rejected over budget exits 3', () => {
  const res = run([
    F(TYPE.RESERVE, 'alice', 1, 600, 1, 0),
    F(TYPE.RESERVE, 'bob', 2, 600, 2, 0),
    F(TYPE.RESERVE, 'carol', 3, 600, 3, 0),
  ], { budget: 1000 });
  assert.equal(res.code, 3);
  assert.match(res.stdout, /member=alice .* status=accept granted=600/);
  assert.match(res.stdout, /member=bob .* status=partial granted=400/);
  assert.match(res.stdout, /member=carol .* status=reject granted=0 reason=budget/);
});

test('partial success alone does not set the over-budget exit code', () => {
  const res = run([
    F(TYPE.RESERVE, 'alice', 1, 600, 1, 0),
    F(TYPE.RESERVE, 'bob', 2, 600, 2, 0),
  ], { budget: 1000 });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /status=partial/);
});

test('unknown reqId exits 4', () => {
  const res = run([F(TYPE.COMMIT, 'alice', 77, 10, 1, 0)]);
  assert.equal(res.code, 4);
  assert.match(res.stdout, /reason=unknown-reqid/);
});

test('re-running without fresh recovers from the existing log and reproduces the run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cli-'));
  const input = path.join(dir, 'frames.bin');
  fs.writeFileSync(input, Buffer.concat([
    F(TYPE.RESERVE, 'alice', 1, 100, 1, 0),
    F(TYPE.COMMIT, 'alice', 1, 40, 2, 1),
  ]));
  const capture = () => {
    let stdout = '';
    const code = runGateway({ input, write: (s) => { stdout += s; }, errWrite: () => {} });
    return { code, stdout };
  };
  const first = capture();
  const second = capture(); // recovers from frames.bin.log
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, first.stdout);
});
