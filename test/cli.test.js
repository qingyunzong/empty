'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGateway } = require('../cli');
const { encodeFrame, TYPE } = require('../frame');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
}

function writeFrames(dir, frames, name = 'frames.bin') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(frames.map(encodeFrame)));
  return file;
}

const SCENARIO = [
  { type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 600, seq: 1 },
  { type: TYPE.RESERVE, member: 'BOB', reqId: 1, amount: 700, seq: 1 },
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 1, amount: 600, seq: 2 },
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 1, amount: 600, seq: 2 }, // retransmission
  { type: TYPE.RELEASE, member: 'BOB', reqId: 1, amount: 400, seq: 2 },
  { type: TYPE.RESERVE, member: 'ALICE', reqId: 2, amount: 100, seq: 3 },
  { type: TYPE.EXPIRE, member: 'SYS', reqId: 0, amount: 100, seq: 1 },
  { type: TYPE.COMMIT, member: 'ALICE', reqId: 2, amount: 100, seq: 4 },
];

test('clean run exits 0 and prints per-request decisions with merkle roots', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [
    { type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 100, seq: 1 },
    { type: TYPE.COMMIT, member: 'ALICE', reqId: 1, amount: 100, seq: 2 },
  ]);
  const r = runGateway(file, {});
  assert.equal(r.code, 0, r.stderr.join('\n'));
  assert.match(r.stdout[0], /#000 RESERVE member=ALICE req=1 want=100 got=100 decision=accept budget=900/);
  assert.match(r.stdout[1], /#001 COMMIT member=ALICE req=1 want=100 got=100 decision=accept budget=900/);
  assert.match(r.stdout[0], /merkle=[0-9a-f]{64}/);
});

test('corrupt frame exits 2', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [{ type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 100, seq: 1 }]);
  const buf = fs.readFileSync(file);
  buf[20] ^= 0xff; // break the checksum
  fs.writeFileSync(file, buf);
  const r = runGateway(file, {});
  assert.equal(r.code, 2);
  assert.match(r.stderr.join('\n'), /corrupt frame/);
});

test('truncated stream exits 2', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [{ type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 100, seq: 1 }]);
  const buf = fs.readFileSync(file);
  fs.writeFileSync(file, buf.subarray(0, 30));
  const r = runGateway(file, {});
  assert.equal(r.code, 2);
});

test('over-budget reserve exits 3', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [
    { type: TYPE.RESERVE, member: 'ALICE', reqId: 1, amount: 1000, seq: 1 },
    { type: TYPE.RESERVE, member: 'BOB', reqId: 1, amount: 500, seq: 1 },
  ]);
  const r = runGateway(file, {});
  assert.equal(r.code, 3, r.stderr.join('\n'));
  assert.match(r.stdout[1], /decision=reject/);
});

test('unknown reqId commit exits 4', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, [
    { type: TYPE.COMMIT, member: 'EVE', reqId: 9, amount: 50, seq: 1 },
  ]);
  const r = runGateway(file, {});
  assert.equal(r.code, 4, r.stderr.join('\n'));
  assert.match(r.stdout[0], /reason=unknown-reqId/);
});

test('duplicate commit in the stream does not double-charge', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, SCENARIO);
  const r = runGateway(file, {});
  assert.match(r.stdout[2], /#002 COMMIT member=ALICE req=1 want=600 got=600 decision=accept/);
  assert.match(r.stdout[3], /#003 COMMIT member=ALICE req=1 .* \[dup\]/);
  const budgetOf = (line) => Number(line.match(/budget=(\d+)/)[1]);
  assert.equal(budgetOf(r.stdout[3]), budgetOf(r.stdout[2]));
});

test('virtual-clock expire emits audit event and late commit is rejected', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, SCENARIO);
  const r = runGateway(file, {});
  const expireLine = r.stdout.findIndex((l) => l.includes('EXPIRE'));
  assert.match(r.stdout[expireLine + 1], /event=EXPIRED member=ALICE req=2 released=100 now=100/);
  const late = r.stdout.find((l) => l.includes('COMMIT') && l.includes('req=2'));
  assert.match(late, /decision=reject reason=expired/);
});

test('crash at any point recovers to the unique golden result', () => {
  const dir = tmpdir();
  const file = writeFrames(dir, SCENARIO);
  const golden = runGateway(file, {});
  assert.equal(golden.code, 0, golden.stderr.join('\n'));
  const nDecisions = Number(golden.stderr.join('\n').match(/decisions=(\d+)/)[1]);

  for (const point of ['before_state', 'after_log', 'after_reply']) {
    for (let crashAt = 0; crashAt < nDecisions; crashAt++) {
      const logPath = path.join(dir, `gw-${point}-${crashAt}.log`);
      const crashed = runGateway(file, {
        CH_LOG: logPath, CH_CRASH_AT: String(crashAt), CH_CRASH_POINT: point,
      });
      assert.equal(crashed.code, 70, `expected crash exit at ${point}#${crashAt}`);
      assert.match(crashed.stderr.join('\n'), /crash:/);
      const recovered = runGateway(file, { CH_LOG: logPath });
      assert.equal(recovered.code, golden.code, `exit diverges at ${point}#${crashAt}`);
      assert.deepEqual(recovered.stdout, golden.stdout, `stdout diverges at ${point}#${crashAt}`);
    }
  }
});
