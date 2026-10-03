import { ChunkedBitset } from './bitset.js';
import { pushVarint, decodeVarint } from './varint.js';

// CJK ideographs become single-character tokens; latin/digit runs become
// one lowercase token. Queries are tokenized with the same rule, so a
// phrase like "换模 后 延迟" matches consecutive token positions.
const TOKEN_RE = /[一-鿿]|[a-zA-Z0-9]+/g;

export function tokenize(text) {
  const tokens = [];
  for (const m of String(text).matchAll(TOKEN_RE)) tokens.push(m[0].toLowerCase());
  return tokens;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Positional inverted index. Postings are compressed on every access:
// doc ids are varint delta-encoded and per-doc positions are stored as a
// chunked bitset with varint-encoded words. Queries always run against the
// decoded compressed form, so compression bugs cannot hide matches.
export class PositionalIndex {
  constructor() {
    this.docs = new Map();     // id -> { text, tokens, meta }
    this.postings = new Map(); // term -> Map(docId -> positions[])
  }

  addDocument(id, text, meta = {}) {
    if (this.docs.has(id)) this.removeDocument(id);
    const tokens = tokenize(text);
    this.docs.set(id, { text, tokens, meta });
    tokens.forEach((tok, pos) => {
      let m = this.postings.get(tok);
      if (!m) this.postings.set(tok, (m = new Map()));
      let arr = m.get(id);
      if (!arr) m.set(id, (arr = []));
      arr.push(pos);
    });
    return id;
  }

  removeDocument(id) {
    const doc = this.docs.get(id);
    if (!doc) return false;
    for (const tok of new Set(doc.tokens)) {
      const m = this.postings.get(tok);
      m.delete(id);
      if (m.size === 0) this.postings.delete(tok);
    }
    this.docs.delete(id);
    return true;
  }

  // term -> Uint8Array: varint docCount, then per doc (sorted by id):
  // varint docId delta, varint bitset length, chunked-bitset bytes.
  encodeTerm(term) {
    const m = this.postings.get(term);
    const out = [];
    if (!m) return Uint8Array.from([0]);
    const ids = [...m.keys()].sort((a, b) => a - b);
    pushVarint(out, ids.length);
    let prev = 0;
    for (const id of ids) {
      pushVarint(out, id - prev);
      prev = id;
      const bs = new ChunkedBitset();
      for (const p of m.get(id)) bs.set(p);
      const enc = bs.encode();
      pushVarint(out, enc.length);
      for (const b of enc) out.push(b);
    }
    return Uint8Array.from(out);
  }

  static decodeTerm(bytes) {
    const postings = new Map();
    let r = decodeVarint(bytes, 0);
    const docCount = r.value;
    let docId = 0;
    for (let k = 0; k < docCount; k++) {
      r = decodeVarint(bytes, r.offset);
      docId += r.value;
      r = decodeVarint(bytes, r.offset);
      const len = r.value;
      const dec = ChunkedBitset.decode(bytes.subarray(r.offset, r.offset + len), 0);
      postings.set(docId, dec.bitset.positions());
      r = { offset: r.offset + len };
    }
    return postings;
  }

  _decodedPostings(term) {
    return PositionalIndex.decodeTerm(this.encodeTerm(term));
  }

  _inWindow(docId, window) {
    if (!window) return true;
    const doc = this.docs.get(docId);
    if (!doc) return false;
    const { start, end } = doc.meta;
    if (start === undefined || end === undefined) return false;
    return overlaps(start, end, window.start, window.end);
  }

  // Exact phrase: tokens must appear at consecutive positions.
  phrase(phraseText, { window } = {}) {
    const terms = tokenize(phraseText);
    if (terms.length === 0) return [];
    const first = this._decodedPostings(terms[0]);
    const rest = terms.slice(1).map((t) => this._decodedPostings(t));
    const results = [];
    for (const [docId, positions] of first) {
      if (!this._inWindow(docId, window)) continue;
      const hits = [];
      for (const p of positions) {
        let ok = true;
        for (let i = 0; i < rest.length; i++) {
          const ps = rest[i].get(docId);
          if (!ps || !ps.includes(p + i + 1)) { ok = false; break; }
        }
        if (ok) hits.push(p);
      }
      if (hits.length) results.push({ docId, positions: hits });
    }
    return results.sort((a, b) => a.docId - b.docId);
  }

  // Proximity: some occurrence of termA within k positions of termB.
  near(termA, termB, k, { window } = {}) {
    const [ta] = tokenize(termA);
    const [tb] = tokenize(termB);
    if (ta === undefined || tb === undefined) return [];
    const pa = this._decodedPostings(ta);
    const pb = this._decodedPostings(tb);
    const results = [];
    for (const [docId, positionsA] of pa) {
      if (!this._inWindow(docId, window)) continue;
      const positionsB = pb.get(docId);
      if (!positionsB) continue;
      const pairs = [];
      for (const a of positionsA) {
        for (const b of positionsB) {
          if (Math.abs(a - b) <= k) pairs.push([a, b]);
        }
      }
      if (pairs.length) results.push({ docId, pairs });
    }
    return results.sort((a, b) => a.docId - b.docId);
  }
}
