'use strict';

const { Engine } = require('../src/engine');
const { encodeFrame, ZERO_HASH } = require('../src/frame');

let counter = 0;
function opId() {
  counter += 1;
  return String(counter).padStart(32, '0');
}

// Build frames for ops in serial seq order, computing prevHash from a
// reference in-memory run. ops: [{ actor, cmd, args, leaseUntil? }]
function buildFrames(ops) {
  const ref = new Engine(null);
  const frames = [];
  ops.forEach((op, i) => {
    const seq = i + 1;
    const prevHash = i === 0 ? ZERO_HASH : ref.chain.entries[i - 1].hash;
    const frame = {
      opId: op.opId || opId(), actor: op.actor, cmd: op.cmd, args: op.args,
      prevHash, seq, leaseUntil: op.leaseUntil ?? 1e9,
    };
    frames.push(frame);
    ref.process(frame, encodeFrame(frame));
  });
  return { frames, ref };
}

function runFrames(frames, { dir = null, order } = {}) {
  const engine = new Engine(dir);
  const list = order ? order.map((i) => frames[i]) : frames;
  for (const f of list) engine.process(f, encodeFrame(f));
  return engine;
}

// All interleavings of per-actor op lists, preserving each actor's order.
function* interleavings(lists) {
  if (lists.every((l) => l.length === 0)) {
    yield [];
    return;
  }
  for (let i = 0; i < lists.length; i++) {
    if (lists[i].length === 0) continue;
    const rest = lists.map((l, j) => (j === i ? l.slice(1) : l));
    for (const tail of interleavings(rest)) yield [lists[i][0], ...tail];
  }
}

module.exports = { buildFrames, runFrames, interleavings, opId };
