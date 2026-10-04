'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameParser, FrameError } = require('../lib/framing');

test('sticky packet: multiple frames in one chunk', () => {
  const p = new FrameParser();
  const frames = p.push('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.deepEqual(p.end(), []);
});

test('half packet: frame split across chunks', () => {
  const p = new FrameParser();
  assert.deepEqual(p.push('{"idemKey":"a1","ty'), []);
  assert.deepEqual(p.push('pe":"auth","amount":100'), []);
  const frames = p.push('}\n');
  assert.deepEqual(frames, [{ idemKey: 'a1', type: 'auth', amount: 100 }]);
});

test('byte-by-byte delivery equals whole delivery', () => {
  const input = '{"x":1}\n{"y":[2,3]}\n{"z":"last-no-newline"}';
  const p = new FrameParser();
  const frames = [];
  for (const ch of input) frames.push(...p.push(ch));
  frames.push(...p.end());
  assert.deepEqual(frames, [{ x: 1 }, { y: [2, 3] }, { z: 'last-no-newline' }]);
});

test('invalid JSON raises FrameError', () => {
  const p = new FrameParser();
  assert.throws(() => p.push('{not json}\n'), FrameError);
  assert.throws(() => p.push('{not json}\n'), (err) => err.code === 'FRAME_ERROR');
});
