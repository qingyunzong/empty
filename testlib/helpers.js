'use strict';

const { encodeFrame, TYPES } = require('../src/frame');

let autoSeq = 0;
function resetSeq() { autoSeq = 0; }

// Build one frame; seq defaults to an auto-incrementing counter.
function frame(type, wo, seq, ack = 0) {
  const s = seq === undefined ? autoSeq++ : seq;
  return encodeFrame({ seq: s, ack, type, payload: wo });
}

function start(wo, seq) { return frame(TYPES.WELD_START, wo, seq); }
function end(wo, seq) { return frame(TYPES.WELD_END, wo, seq); }
function undo(wo, seq) { return frame(TYPES.UNDO, wo, seq); }

function stream(...frames) { return Buffer.concat(frames); }

function toHex(buf) { return buf.toString('hex'); }

// Deterministic PRNG (mulberry32) for property tests.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { frame, start, end, undo, stream, toHex, resetSeq, rng };
