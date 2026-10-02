'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../cli');
const { encodeStream } = require('../src/frame');

const KEY = 'dev-key';

test('cli exit 0 and prints report for a valid stream', () => {
  const bin = encodeStream(
    [
      { authId: 'A', type: 'hold', seq: 1, amount: 500, ts: 0 },
      { authId: 'A', type: 'complete', seq: 2, amount: 200, ts: 1 },
    ],
    { key: KEY, fragmentSize: 9 },
  );
  const res = run(bin, { key: KEY });
  assert.equal(res.exitCode, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.auths.A.status, 'COMPLETED');
  assert.equal(report.auths.A.charged, 200);
});

test('cli exit 2 on mac error', () => {
  const bin = Buffer.from(
    encodeStream([{ authId: 'A', type: 'hold', seq: 1, amount: 500, ts: 0 }], { key: KEY }),
  );
  bin[bin.length - 1] ^= 0x01;
  const res = run(bin, { key: KEY });
  assert.equal(res.exitCode, 2);
  assert.match(res.stderr, /MAC_ERROR/);
});

test('cli exit 3 on seq conflict', () => {
  const bin = encodeStream(
    [
      { authId: 'A', type: 'hold', seq: 1, amount: 500, ts: 0 },
      { authId: 'A', type: 'inc', seq: 2, amount: 10, ts: 1 },
      { authId: 'A', type: 'inc', seq: 2, amount: 20, ts: 1 },
    ],
    { key: KEY },
  );
  const res = run(bin, { key: KEY });
  assert.equal(res.exitCode, 3);
  assert.match(res.stderr, /SEQ_CONFLICT/);
});

test('cli exit 4 on negative frozen', () => {
  const bin = encodeStream(
    [
      { authId: 'A', type: 'hold', seq: 1, amount: 100, ts: 0 },
      { authId: 'A', type: 'dec', seq: 2, amount: 500, ts: 1 },
    ],
    { key: KEY },
  );
  const res = run(bin, { key: KEY });
  assert.equal(res.exitCode, 4);
  assert.match(res.stderr, /NEGATIVE_FROZEN/);
});
