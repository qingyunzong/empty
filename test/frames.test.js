'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ev, close, tmpdir, writeFrames, runCli } = require('./helpers');
const { encodeStream, decodeStream, encodeFrame } = require('../lib/frames');

test('frame roundtrip preserves fields', () => {
  const objs = [ev('e1', 'A', 100, 1, 10), close('P1', 100)];
  const { frames, tail } = decodeStream(encodeStream(objs));
  assert.equal(tail.length, 0);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].obj.eventId, 'e1');
  assert.equal(frames[0].obj.amount, 100);
  assert.equal(frames[1].obj.type, 'close');
  assert.ok(/^[0-9a-f]{8}$/.test(frames[0].obj.checksum));
});

test('bad checksum exits 2', () => {
  const { dir, file } = writeFrames([ev('e1', 'A', 100, 1, 10)]);
  const buf = fs.readFileSync(file);
  buf[buf.length - 3] ^= 0xFF; // corrupt payload/checksum
  fs.writeFileSync(file, buf);
  const r = runCli(file);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /checksum|JSON/);
});

test('garbage length prefix exits 2', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'frames.bin');
  fs.writeFileSync(file, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 1, 2, 3]));
  const r = runCli(file);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /invalid frame length/);
});

test('trailing partial frame is tolerated and reported', () => {
  const { dir, file } = writeFrames([ev('e1', 'A', 100, 1, 10)]);
  const full = fs.readFileSync(file);
  const partial = encodeFrame(ev('e2', 'A', 5, 2, 11)).slice(0, 7); // half frame
  fs.writeFileSync(file, Buffer.concat([full, partial]));
  const r = runCli(file);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.balances.A, 100);
  assert.equal(out.incompleteTailBytes, 7);
});

test('interleaved partial then valid bytes: partial only valid at tail', () => {
  const buf = encodeStream([ev('e1', 'A', 1, 1, 1), ev('e2', 'B', 2, 1, 2)]);
  const cut = buf.slice(0, buf.length - 4);
  const { frames, tail } = decodeStream(cut);
  assert.equal(frames.length, 1);
  assert.equal(tail.length, buf.length - 4 - (4 + frames[0].raw.length - 4));
  assert.ok(tail.length > 0);
});
