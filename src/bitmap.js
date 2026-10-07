'use strict';

// Roaring-style bitmap: 32-bit id space split into 16-bit high/low parts.
// Each high key maps to a container: sorted array, or bitset when dense.
const CONTAINER_SIZE = 1 << 16;
const ARRAY_TO_BITSET = 4096;

class Bitmap {
  constructor() {
    this.containers = new Map(); // high -> { kind: 'array'|'bitset', data }
    this.size = 0;
  }

  static _high(id) { return id >>> 16; }
  static _low(id) { return id & 0xffff; }

  has(id) {
    const c = this.containers.get(Bitmap._high(id));
    if (!c) return false;
    const low = Bitmap._low(id);
    if (c.kind === 'array') return binarySearch(c.data, low) >= 0;
    return (c.data[low >>> 3] & (1 << (low & 7))) !== 0;
  }

  add(id) {
    const high = Bitmap._high(id);
    const low = Bitmap._low(id);
    let c = this.containers.get(high);
    if (!c) {
      c = { kind: 'array', data: [low] };
      this.containers.set(high, c);
      this.size++;
      return true;
    }
    if (c.kind === 'array') {
      const i = binarySearch(c.data, low);
      if (i >= 0) return false;
      c.data.splice(~i, 0, low);
      this.size++;
      if (c.data.length > ARRAY_TO_BITSET) this._convert(high, c);
      return true;
    }
    const byte = low >>> 3;
    const mask = 1 << (low & 7);
    if (c.data[byte] & mask) return false;
    c.data[byte] |= mask;
    this.size++;
    return true;
  }

  delete(id) {
    const high = Bitmap._high(id);
    const low = Bitmap._low(id);
    const c = this.containers.get(high);
    if (!c) return false;
    if (c.kind === 'array') {
      const i = binarySearch(c.data, low);
      if (i < 0) return false;
      c.data.splice(i, 1);
      this.size--;
      if (c.data.length === 0) this.containers.delete(high);
      return true;
    }
    const byte = low >>> 3;
    const mask = 1 << (low & 7);
    if (!(c.data[byte] & mask)) return false;
    c.data[byte] &= ~mask;
    this.size--;
    // Optionally shrink back to array when sparse.
    if (this.size % 1 === 0) {
      let count = 0;
      for (const b of c.data) count += popcount8(b);
      if (count === 0) this.containers.delete(high);
      else if (count <= ARRAY_TO_BITSET / 2) this._convert(high, c);
    }
    return true;
  }

  _convert(high, c) {
    if (c.kind === 'array') {
      const bits = new Uint8Array(CONTAINER_SIZE / 8);
      for (const low of c.data) bits[low >>> 3] |= 1 << (low & 7);
      c.kind = 'bitset';
      c.data = bits;
    } else {
      const arr = [];
      for (let low = 0; low < CONTAINER_SIZE; low++) {
        if (c.data[low >>> 3] & (1 << (low & 7))) arr.push(low);
      }
      c.kind = 'array';
      c.data = arr;
    }
  }

  // Sorted ascending ids.
  toArray() {
    const out = [];
    const highs = [...this.containers.keys()].sort((a, b) => a - b);
    for (const high of highs) {
      const c = this.containers.get(high);
      const base = high << 16;
      if (c.kind === 'array') {
        for (const low of c.data) out.push(base + low);
      } else {
        for (let low = 0; low < CONTAINER_SIZE; low++) {
          if (c.data[low >>> 3] & (1 << (low & 7))) out.push(base + low);
        }
      }
    }
    return out;
  }

  clone() {
    const b = new Bitmap();
    for (const [high, c] of this.containers) {
      b.containers.set(high, {
        kind: c.kind,
        data: c.kind === 'array' ? c.data.slice() : new Uint8Array(c.data),
      });
    }
    b.size = this.size;
    return b;
  }

  serialize() {
    const obj = { size: this.size, containers: [] };
    const highs = [...this.containers.keys()].sort((a, b) => a - b);
    for (const high of highs) {
      const c = this.containers.get(high);
      obj.containers.push({
        high,
        kind: c.kind,
        data: c.kind === 'array' ? c.data : Buffer.from(c.data).toString('base64'),
      });
    }
    return obj;
  }

  static deserialize(obj) {
    const b = new Bitmap();
    b.size = obj.size;
    for (const c of obj.containers) {
      b.containers.set(c.high, {
        kind: c.kind,
        data: c.kind === 'array' ? c.data.slice() : new Uint8Array(Buffer.from(c.data, 'base64')),
      });
    }
    return b;
  }
}

function binarySearch(arr, x) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] === x) return mid;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return ~lo;
}

function popcount8(b) {
  b = b - ((b >> 1) & 0x55);
  b = (b & 0x33) + ((b >> 2) & 0x33);
  return (b + (b >> 4)) & 0x0f;
}

module.exports = { Bitmap };
