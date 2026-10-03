'use strict';

const { encodeFrame, TYPE } = require('../lib/frame');
const { Framer } = require('../lib/framer');
const { Gateway } = require('../lib/gateway');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function frame(seq, type, payload, ack = 0) {
  return encodeFrame({ type: TYPE[type], seq, ack, payload });
}

// Runs frames (buffers) through framer + gateway with the given chunking.
function runStream(buffers, { chunkSize = 1024, timeout = 1000, maxRetries = 5 } = {}) {
  const stream = Buffer.concat(buffers);
  const framer = new Framer();
  const gateway = new Gateway({ timeout, maxRetries });
  const events = [];
  const handle = (frames) => {
    for (const f of frames) events.push(...gateway.ingest(f));
  };
  for (let off = 0; off < stream.length; off += chunkSize) {
    handle(framer.push(stream.subarray(off, off + chunkSize)));
  }
  handle(framer.end());
  events.push(...gateway.finish());
  return { events, gateway };
}

function businessEvents(events) {
  return events.filter((e) => e.event === 'WELD_START' || e.event === 'WELD_END' || e.event === 'WELD_END_REVERSED');
}

// Independent reference enumeration: canonical in-order op list -> events.
function referenceEvents(ops) {
  return ops.map((op, seq) => {
    if (op.type === 'WELD_START') return { event: 'WELD_START', seq, orderId: op.orderId, weldId: op.weldId ?? null };
    if (op.type === 'WELD_END') return { event: 'WELD_END', seq, orderId: op.orderId, weldId: op.weldId ?? null };
    return { event: 'WELD_END_REVERSED', seq, orderId: op.orderId, targetSeq: op.targetSeq };
  });
}

// Generates a random canonical op list where every UNDO is rule-valid.
function genOps(rand, n, orderIds = ['A', 'B', 'C']) {
  const ops = [];
  const undone = new Set();
  const lastStart = new Map();
  const pickOrder = () => orderIds[Math.floor(rand() * orderIds.length)];
  for (let i = 0; i < n; i++) {
    const r = rand();
    const orderId = pickOrder();
    if (r < 0.35) {
      ops.push({ type: 'WELD_START', orderId, weldId: `w${i}` });
      lastStart.set(orderId, i);
    } else if (r < 0.8 || ops.length === 0) {
      ops.push({ type: 'WELD_END', orderId, weldId: `w${i}` });
    } else {
      const candidates = [];
      for (let s = 0; s < ops.length; s++) {
        const op = ops[s];
        if (op.type === 'WELD_END' && op.orderId === orderId && !undone.has(s)
            && (lastStart.get(orderId) ?? -1) < s) {
          candidates.push(s);
        }
      }
      if (candidates.length === 0) {
        ops.push({ type: 'WELD_END', orderId, weldId: `w${i}` });
        continue;
      }
      const target = candidates[Math.floor(rand() * candidates.length)];
      undone.add(target);
      ops.push({ type: 'UNDO', orderId, targetSeq: target });
    }
  }
  return ops;
}

module.exports = { mulberry32, frame, runStream, businessEvents, referenceEvents, genOps };
