'use strict';

// Content-defined chunking via a rolling (rsync-style) weak checksum.
// Boundary is a deterministic function of the sliding window content,
// so identical content always yields identical chunks.

const WINDOW = 64;
const MIN_CHUNK = 2048;
const AVG_CHUNK = 8192;
const MAX_CHUNK = 32768;
const MASK = AVG_CHUNK - 1;

function adler32(buf) {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < buf.length) {
    const end = Math.min(i + 5552, buf.length);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function chunkBuffer(buf) {
  if (buf.length === 0) return [];
  const chunks = [];
  const ring = new Uint8Array(WINDOW);
  let pos = 0;
  let filled = 0;
  let a = 0;
  let b = 0;
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    const inB = buf[i];
    let outB = 0;
    if (filled === WINDOW) outB = ring[pos];
    else filled++;
    ring[pos] = inB;
    pos = (pos + 1) % WINDOW;
    a = (a + inB - outB) & 0xffff;
    b = (b + a - WINDOW * outB) & 0xffff;
    const len = i - start + 1;
    const digest = ((b << 16) | a) >>> 0;
    if ((len >= MIN_CHUNK && (digest & MASK) === 0) || len >= MAX_CHUNK) {
      chunks.push(buf.subarray(start, i + 1));
      start = i + 1;
      a = 0;
      b = 0;
      filled = 0;
    }
  }
  if (start < buf.length) chunks.push(buf.subarray(start));
  return chunks;
}

module.exports = { adler32, chunkBuffer, MIN_CHUNK, AVG_CHUNK, MAX_CHUNK };
