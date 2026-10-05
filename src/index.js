// Frozen-layer postings: delta + varint encoded blocks with a skip list.
export const BLOCK_SIZE = 16;

function encodeVarint(n, out) {
  let v = n;
  for (;;) {
    const b = v % 128;
    v = Math.floor(v / 128);
    if (v === 0) { out.push(b); return; }
    out.push(b | 0x80);
  }
}

function decodeVarint(buf, state) {
  let shift = 0;
  let value = 0;
  for (;;) {
    const b = buf[state.i++];
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return value;
    shift += 7;
  }
}

// positions: sorted ascending, unique integers.
export function encodePostings(positions) {
  const blocks = [];
  const skip = [];
  let prev = 0;
  for (let i = 0; i < positions.length; i += BLOCK_SIZE) {
    const chunk = positions.slice(i, i + BLOCK_SIZE);
    const bytes = [];
    for (const pos of chunk) {
      encodeVarint(pos - prev, bytes);
      prev = pos;
    }
    blocks.push(Buffer.from(bytes).toString('base64'));
    skip.push({ last: chunk[chunk.length - 1], count: chunk.length });
  }
  return { count: positions.length, blocks, skip };
}

// Decode positions, optionally only those >= minPos, using the skip list to
// avoid decoding blocks that cannot contain a match.
export function decodePostings(enc, minPos = -Infinity) {
  const out = [];
  let prev = 0;
  let startBlock = 0;
  if (minPos !== -Infinity) {
    while (startBlock < enc.skip.length && enc.skip[startBlock].last < minPos) startBlock++;
    // skip list stores the last pos of each block, so the delta base for the
    // first decoded block is the last pos of the previous block.
    prev = startBlock > 0 ? enc.skip[startBlock - 1].last : 0;
  }
  for (let b = startBlock; b < enc.blocks.length; b++) {
    const buf = Buffer.from(enc.blocks[b], 'base64');
    const state = { i: 0 };
    const n = enc.skip[b].count;
    for (let k = 0; k < n; k++) {
      prev += decodeVarint(buf, state);
      if (prev >= minPos) out.push(prev);
    }
  }
  return out;
}

// Active-layer exact small index: token -> sorted positions per device.
export class ActiveIndex {
  constructor() {
    this.byToken = new Map(); // token -> Map(device -> number[])
  }

  add(token, device, pos) {
    let perDevice = this.byToken.get(token);
    if (!perDevice) {
      perDevice = new Map();
      this.byToken.set(token, perDevice);
    }
    let list = perDevice.get(device);
    if (!list) {
      list = [];
      perDevice.set(device, list);
    }
    list.push(pos);
  }

  postings(token, device) {
    const perDevice = this.byToken.get(token);
    if (!perDevice) return [];
    return perDevice.get(device) || [];
  }
}
