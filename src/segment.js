import { createHash } from 'node:crypto';
import { QError } from './errors.js';
import { uvarintEncode, uvarintDecode } from './varint.js';

const MAGIC = Buffer.from('QSEG');
const SUM_LEN = 32;

export function tokenize(text) {
  return text.split(/\s+/u).filter((t) => t.length > 0);
}

export function buildIndex(tokens) {
  const index = new Map();
  tokens.forEach((tok, pos) => {
    let arr = index.get(tok);
    if (!arr) index.set(tok, (arr = []));
    arr.push(pos);
  });
  return index;
}

// Binary layout:
//   'QSEG' | varint headerLen | headerJSON | varint textLen | text
//   | varint tokenCount | per token: varint tokLen tokBytes varint posCount delta-varints
//   | sha256(body) (32 bytes)
export function encodeSegment({ id, epoch, text }) {
  const tokens = tokenize(text);
  const index = buildIndex(tokens);
  const header = Buffer.from(JSON.stringify({ id, epoch }), 'utf8');
  const textBuf = Buffer.from(text, 'utf8');
  const parts = [MAGIC, uvarintEncode(header.length), header, uvarintEncode(textBuf.length), textBuf];
  const keys = [...index.keys()].sort();
  parts.push(uvarintEncode(keys.length));
  for (const key of keys) {
    const kb = Buffer.from(key, 'utf8');
    parts.push(uvarintEncode(kb.length), kb);
    const positions = index.get(key);
    parts.push(uvarintEncode(positions.length));
    let prev = 0;
    for (const p of positions) {
      parts.push(uvarintEncode(p - prev));
      prev = p;
    }
  }
  const body = Buffer.concat(parts);
  const sum = createHash('sha256').update(body).digest();
  return Buffer.concat([body, sum]);
}

export function decodeSegment(buf) {
  const torn = (msg) => new QError('E_TORN', `segment torn: ${msg}`);
  if (buf.length < MAGIC.length + SUM_LEN) throw torn('too short');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw torn('bad magic');
  const body = buf.subarray(0, buf.length - SUM_LEN);
  const sum = buf.subarray(buf.length - SUM_LEN);
  const expect = createHash('sha256').update(body).digest();
  if (!sum.equals(expect)) throw torn('checksum mismatch');
  let off = 4;
  let headerLen, header, textLen, textBuf, tokenCount;
  [headerLen, off] = uvarintDecode(buf, off);
  if (off + headerLen > body.length) throw torn('header overruns body');
  header = JSON.parse(buf.subarray(off, off + headerLen).toString('utf8'));
  off += headerLen;
  [textLen, off] = uvarintDecode(buf, off);
  if (off + textLen > body.length) throw torn('text overruns body');
  textBuf = buf.subarray(off, off + textLen);
  off += textLen;
  [tokenCount, off] = uvarintDecode(buf, off);
  const index = new Map();
  for (let i = 0; i < tokenCount; i++) {
    let tokLen, posCount;
    [tokLen, off] = uvarintDecode(buf, off);
    if (off + tokLen > body.length) throw torn('token overruns body');
    const tok = buf.subarray(off, off + tokLen).toString('utf8');
    off += tokLen;
    [posCount, off] = uvarintDecode(buf, off);
    const positions = [];
    let prev = 0;
    for (let j = 0; j < posCount; j++) {
      let delta;
      [delta, off] = uvarintDecode(buf, off);
      prev += delta;
      positions.push(prev);
    }
    index.set(tok, positions);
  }
  if (off !== body.length) throw torn('trailing garbage');
  return { id: header.id, epoch: header.epoch, text: textBuf.toString('utf8'), index };
}

// Returns start positions where the phrase tokens occur consecutively.
export function findPhrase(index, phrase) {
  const pts = tokenize(phrase);
  if (pts.length === 0) return [];
  const first = index.get(pts[0]);
  if (!first) return [];
  const out = [];
  for (const p of first) {
    let ok = true;
    for (let k = 1; k < pts.length; k++) {
      const arr = index.get(pts[k]);
      if (!arr || !arr.includes(p + k)) { ok = false; break; }
    }
    if (ok) out.push(p);
  }
  return out;
}
