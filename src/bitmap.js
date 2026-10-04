'use strict';
// Roaring-style compressed bitmap: 64k chunks, array/run/bitset containers.

const ARRAY_LIMIT = 4096;
const BITSET_WORDS = 2048; // 65536 / 32

function runCount(sorted) {
  let runs = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1] + 1) runs++;
  }
  return runs;
}

function runsFromArray(sorted) {
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push([sorted[i], j - i + 1]);
    i = j + 1;
  }
  return out;
}

function bitsetFromArray(sorted) {
  const w = new Uint32Array(BITSET_WORDS);
  for (const x of sorted) w[x >>> 5] |= 1 << (x & 31);
  return w;
}

function bitsetToArray(w) {
  const out = [];
  for (let i = 0; i < BITSET_WORDS; i++) {
    let word = w[i];
    while (word) {
      const bit = word & -word;
      out.push((i << 5) + (31 - Math.clz32(bit)));
      word ^= bit;
    }
  }
  return out;
}

function containerFromArray(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  let best;
  if (n <= ARRAY_LIMIT) best = { t: 'a', v: sorted.slice() };
  else best = { t: 'b', v: bitsetFromArray(sorted) };
  const bestSize = best.t === 'a' ? n : BITSET_WORDS;
  const runs = runCount(sorted);
  if (runs * 2 < bestSize) best = { t: 'r', v: runsFromArray(sorted) };
  return best;
}

function containerToArray(c) {
  if (c.t === 'a') return c.v.slice();
  if (c.t === 'b') return bitsetToArray(c.v);
  const out = [];
  for (const [start, len] of c.v) for (let i = 0; i < len; i++) out.push(start + i);
  return out;
}

function containerHas(c, x) {
  if (c.t === 'b') return (c.v[x >>> 5] & (1 << (x & 31))) !== 0;
  if (c.t === 'a') {
    let lo = 0, hi = c.v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c.v[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo < c.v.length && c.v[lo] === x;
  }
  for (const [start, len] of c.v) {
    if (x < start) return false;
    if (x < start + len) return true;
  }
  return false;
}

function containerCardinality(c) {
  if (c.t === 'a') return c.v.length;
  if (c.t === 'r') return c.v.reduce((s, [, len]) => s + len, 0);
  let n = 0;
  for (const w of c.v) n += popcount(w);
  return n;
}

function popcount(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function containerToJSON(c) {
  if (c.t === 'b') return { t: 'b', v: Buffer.from(c.v.buffer, c.v.byteOffset, c.v.byteLength).toString('base64') };
  return { t: c.t, v: c.v };
}

function containerFromJSON(j) {
  if (j.t === 'b') {
    const buf = Buffer.from(j.v, 'base64');
    const w = new Uint32Array(BITSET_WORDS);
    w.set(new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    return { t: 'b', v: w };
  }
  return { t: j.t, v: j.v };
}

export class Bitmap {
  constructor() {
    this.chunks = new Map(); // high16 -> container
  }

  static fromArray(values) {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    const bm = new Bitmap();
    let i = 0;
    while (i < sorted.length) {
      const hi = sorted[i] >>> 16;
      const lows = [];
      while (i < sorted.length && (sorted[i] >>> 16) === hi) {
        lows.push(sorted[i] & 0xffff);
        i++;
      }
      bm.chunks.set(hi, containerFromArray(lows));
    }
    return bm;
  }

  has(x) {
    const c = this.chunks.get(x >>> 16);
    return c ? containerHas(c, x & 0xffff) : false;
  }

  add(x) {
    const hi = x >>> 16, lo = x & 0xffff;
    const c = this.chunks.get(hi);
    if (!c) {
      this.chunks.set(hi, { t: 'a', v: [lo] });
      return;
    }
    const arr = containerToArray(c);
    let i = 0;
    while (i < arr.length && arr[i] < lo) i++;
    if (i < arr.length && arr[i] === lo) return;
    arr.splice(i, 0, lo);
    this.chunks.set(hi, containerFromArray(arr));
  }

  remove(x) {
    const hi = x >>> 16, lo = x & 0xffff;
    const c = this.chunks.get(hi);
    if (!c) return;
    const arr = containerToArray(c).filter((v) => v !== lo);
    if (arr.length === 0) this.chunks.delete(hi);
    else this.chunks.set(hi, containerFromArray(arr));
  }

  get cardinality() {
    let n = 0;
    for (const c of this.chunks.values()) n += containerCardinality(c);
    return n;
  }

  toArray() {
    const out = [];
    const keys = [...this.chunks.keys()].sort((a, b) => a - b);
    for (const hi of keys) {
      for (const lo of containerToArray(this.chunks.get(hi))) out.push((hi << 16) | lo);
    }
    return out;
  }

  static _combine(a, b, fn) {
    const out = new Bitmap();
    const keys = new Set([...a.chunks.keys(), ...b.chunks.keys()]);
    for (const k of keys) {
      const ca = a.chunks.get(k), cb = b.chunks.get(k);
      const arrA = ca ? containerToArray(ca) : [];
      const arrB = cb ? containerToArray(cb) : [];
      const merged = fn(arrA, arrB);
      const c = containerFromArray(merged);
      if (c) out.chunks.set(k, c);
    }
    return out;
  }

  or(other) {
    return Bitmap._combine(this, other, (a, b) => [...new Set([...a, ...b])].sort((x, y) => x - y));
  }

  and(other) {
    return Bitmap._combine(this, other, (a, b) => {
      const sb = new Set(b);
      return a.filter((x) => sb.has(x));
    });
  }

  andNot(other) {
    return Bitmap._combine(this, other, (a, b) => {
      const sb = new Set(b);
      return a.filter((x) => !sb.has(x));
    });
  }

  equals(other) {
    if (this.chunks.size !== other.chunks.size) return false;
    for (const [k, c] of this.chunks) {
      const oc = other.chunks.get(k);
      if (!oc) return false;
      const a = containerToArray(c), b = containerToArray(oc);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) return false;
    }
    return true;
  }

  toJSON() {
    return [...this.chunks.keys()]
      .sort((a, b) => a - b)
      .map((k) => [k, containerToJSON(this.chunks.get(k))]);
  }

  static fromJSON(arr) {
    const bm = new Bitmap();
    for (const [k, cj] of arr) bm.chunks.set(k, containerFromJSON(cj));
    return bm;
  }
}
