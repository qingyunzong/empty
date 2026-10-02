'use strict';

const MOD_ADLER = 65521;
const NMAX = 5552;

function adler32(buf) {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < buf.length) {
    const end = Math.min(i + NMAX, buf.length);
    for (; i < end; i++) {
      a += buf[i];
      b += a;
    }
    a %= MOD_ADLER;
    b %= MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

function adler32hex(buf) {
  return adler32(buf).toString(16).padStart(8, '0');
}

module.exports = { adler32, adler32hex };
