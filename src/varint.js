// Unsigned LEB128 varint + segment posting codec.
// Segment layout (all integers varint, positions delta-encoded):
//   docCount
//   per doc (docKeys sorted):
//     docKey string, termCount
//     per term (sorted): term string, posCount, position deltas
//   tombstoneCount
//   per tombstone (sorted): docKey string

export function writeVarint(out, n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`varint: cannot encode ${n}`);
  }
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

export function readVarint(bytes, state) {
  let result = 0;
  let shift = 1;
  let byte;
  do {
    if (state.offset >= bytes.length) throw new Error('varint: truncated input');
    byte = bytes[state.offset++];
    result += (byte & 0x7f) * shift;
    shift *= 0x80;
    if (!Number.isSafeInteger(result)) throw new Error('varint: value overflow');
  } while (byte & 0x80);
  return result;
}

function writeString(out, s) {
  const bytes = Buffer.from(s, 'utf8');
  writeVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function readString(bytes, state) {
  const len = readVarint(bytes, state);
  if (state.offset + len > bytes.length) throw new Error('varint: truncated string');
  const s = Buffer.from(bytes.subarray(state.offset, state.offset + len)).toString('utf8');
  state.offset += len;
  return s;
}

// seg: { docs: { docKey: { term: [pos, ...] } }, tombstones: [docKey, ...] }
export function encodeSegment(seg) {
  const out = [];
  const docKeys = Object.keys(seg.docs).sort();
  writeVarint(out, docKeys.length);
  for (const docKey of docKeys) {
    writeString(out, docKey);
    const terms = Object.keys(seg.docs[docKey]).sort();
    writeVarint(out, terms.length);
    for (const term of terms) {
      writeString(out, term);
      const positions = seg.docs[docKey][term];
      writeVarint(out, positions.length);
      let prev = 0;
      positions.forEach((p, i) => {
        writeVarint(out, i === 0 ? p : p - prev);
        prev = p;
      });
    }
  }
  const tombstones = [...seg.tombstones].sort();
  writeVarint(out, tombstones.length);
  for (const docKey of tombstones) writeString(out, docKey);
  return Buffer.from(out);
}

export function decodeSegment(buf) {
  const state = { offset: 0 };
  const docs = {};
  const docCount = readVarint(buf, state);
  for (let d = 0; d < docCount; d += 1) {
    const docKey = readString(buf, state);
    const termCount = readVarint(buf, state);
    const termMap = {};
    for (let t = 0; t < termCount; t += 1) {
      const term = readString(buf, state);
      const posCount = readVarint(buf, state);
      const positions = [];
      let prev = 0;
      for (let i = 0; i < posCount; i += 1) {
        const delta = readVarint(buf, state);
        const p = i === 0 ? delta : prev + delta;
        positions.push(p);
        prev = p;
      }
      termMap[term] = positions;
    }
    docs[docKey] = termMap;
  }
  const tombCount = readVarint(buf, state);
  const tombstones = [];
  for (let i = 0; i < tombCount; i += 1) tombstones.push(readString(buf, state));
  if (state.offset !== buf.length) throw new Error('varint: trailing bytes');
  return { docs, tombstones };
}
