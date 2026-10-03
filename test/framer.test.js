'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Framer, FrameError } = require('../lib/framer');

test('sticky packets: multiple frames in one chunk', () => {
  const f = new Framer();
  const out = f.push('{"a":1}\n{"a":2}\n{"a":3}\n');
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }, { a: 3 }]);
  f.end();
});

test('half packet: one frame split across chunks', () => {
  const f = new Framer();
  const frame = '{"idemKey":"a1","type":"auth","amount":200,"seq":1,"ts":1000}';
  const mid = 17;
  assert.deepEqual(f.push(frame.slice(0, mid)), []);
  assert.deepEqual(f.push(frame.slice(mid) + '\n'), [JSON.parse(frame)]);
  f.end();
});

test('byte-by-byte delivery reassembles frames', () => {
  const f = new Framer();
  const frames = [];
  const wire = '{"x":1}\n{"x":2}\n';
  for (const ch of wire) frames.push(...f.push(ch));
  assert.deepEqual(frames, [{ x: 1 }, { x: 2 }]);
  f.end();
});

test('mixed: partial frame followed by sticky frames', () => {
  const f = new Framer();
  assert.deepEqual(f.push('{"x":1}\n{"x":'), [{ x: 1 }]);
  assert.deepEqual(f.push('2}\n{"x":3}\n{"x":4}\n'), [{ x: 2 }, { x: 3 }, { x: 4 }]);
  f.end();
});

test('invalid JSON frame raises FrameError', () => {
  const f = new Framer();
  assert.throws(() => f.push('{"x":1}\nnot json\n'), FrameError);
});

test('truncated trailing frame at end() raises FrameError', () => {
  const f = new Framer();
  f.push('{"x":1}\n{"x":2');
  assert.throws(() => f.end(), FrameError);
});

test('blank lines are ignored', () => {
  const f = new Framer();
  assert.deepEqual(f.push('\n{"x":1}\n\n\n'), [{ x: 1 }]);
  f.end();
});
