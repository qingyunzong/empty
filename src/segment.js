import { gzipSync, gunzipSync } from 'node:zlib';
import { encodeDeltas, decodeDeltas } from './varint.js';

// A segment is { id, file, postings: {term: {tradeId: [pos...]}}, docs: Set, positions: number, dead: number }
// On disk: gzip(JSON) where every position list is varint delta-encoded + base64.

export function encodeSegment(seg) {
  const postings = {};
  for (const [term, docs] of Object.entries(seg.postings)) {
    postings[term] = Object.entries(docs).map(([tradeId, positions]) => [
      tradeId,
      encodeDeltas(positions),
    ]);
  }
  const json = JSON.stringify({
    id: seg.id,
    docs: [...seg.docs],
    positions: seg.positions,
    postings,
  });
  return gzipSync(Buffer.from(json, 'utf8'));
}

export function decodeSegment(buf) {
  const raw = JSON.parse(gunzipSync(buf).toString('utf8'));
  const postings = {};
  for (const [term, docs] of Object.entries(raw.postings)) {
    postings[term] = {};
    for (const [tradeId, b64] of docs) postings[term][tradeId] = decodeDeltas(b64);
  }
  return {
    id: raw.id,
    file: null,
    postings,
    docs: new Set(raw.docs),
    positions: raw.positions,
    dead: 0,
  };
}
