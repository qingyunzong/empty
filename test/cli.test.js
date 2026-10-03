'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { encode, TYPE } = require('../lib/frame');
const { merkleRoot } = require('../lib/merkle');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smt-gw-'));
}

function runCli(streamBuf, dir) {
  const stream = path.join(dir, 's.bin');
  const out = path.join(dir, 'certs.json');
  const log = path.join(dir, 'frames.log');
  fs.writeFileSync(stream, streamBuf);
  const res = spawnSync(process.execPath, [CLI, '--stream', stream, '--out', out, '--frames-log', log], { encoding: 'utf8' });
  const certs = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  const events = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return { res, certs, events };
}

function payloadOf(n) {
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i++) buf[i] = (i * 13 + 5) & 0xFF;
  return buf;
}

test('CLI happy path exits 0 and writes certs.json + frames.log', () => {
  const dir = tmpdir();
  const payload = payloadOf(2048);
  const stream = Buffer.concat([
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 1024, payload: payload.subarray(1024) }),
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload: payload.subarray(0, 1024) }),
    encode({ type: TYPE.END, board: 1, session: 1 }),
  ]);
  const { res, certs, events } = runCli(stream, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(certs.certs.length, 1);
  assert.equal(certs.certs[0].merkleRoot, merkleRoot(payload));
  assert.equal(certs.certs[0].receivedBytes, 2048);
  assert.ok(events.some((e) => e.event === 'commit'));
});

test('CLI exits 2 on truncated tail yet keeps committed certs', () => {
  const dir = tmpdir();
  const payload = payloadOf(64);
  const half = encode({ type: TYPE.DATA, board: 2, session: 1, offset: 0, payload: payloadOf(30) }).subarray(0, 11);
  const stream = Buffer.concat([
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload }),
    encode({ type: TYPE.END, board: 1, session: 1 }),
    half,
  ]);
  const { res, certs, events } = runCli(stream, dir);
  assert.equal(res.status, 2);
  assert.equal(certs.certs.length, 1);
  assert.equal(certs.certs[0].board, 1);
  assert.equal(certs.certs[0].status, 'committed');
  assert.ok(events.some((e) => e.event === 'truncated_tail'));
});

test('CLI exits 2 on bad magic', () => {
  const dir = tmpdir();
  const { res } = runCli(Buffer.from([0xDE, 0xAD, 0x00]), dir);
  assert.equal(res.status, 2);
});

test('CLI exits 6 on same-session conflict and preserves the old cert', () => {
  const dir = tmpdir();
  const payload = payloadOf(64);
  const stream = Buffer.concat([
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload }),
    encode({ type: TYPE.END, board: 1, session: 1 }),
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload: payloadOf(8) }),
  ]);
  const { res, certs, events } = runCli(stream, dir);
  assert.equal(res.status, 6);
  assert.equal(certs.certs.length, 1);
  assert.equal(certs.certs[0].status, 'committed');
  assert.equal(certs.certs[0].merkleRoot, merkleRoot(payload));
  assert.ok(events.some((e) => e.event === 'conflict'));
});

test('CLI logs bad_crc and still exits 0', () => {
  const dir = tmpdir();
  const payload = payloadOf(32);
  const stream = Buffer.concat([
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload, corruptCrc: true }),
    encode({ type: TYPE.DATA, board: 1, session: 1, offset: 0, payload }),
    encode({ type: TYPE.END, board: 1, session: 1 }),
  ]);
  const { res, certs, events } = runCli(stream, dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(certs.stats.badCrc, 1);
  assert.ok(events.some((e) => e.event === 'bad_crc'));
  assert.equal(certs.certs[0].merkleRoot, merkleRoot(payload));
});
