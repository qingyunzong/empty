// Compressed positional inverted index over policyText.
// Postings are delta-encoded and varint-compressed into base64 payloads,
// persisted as segment files under <dir>/index/. Purge merges segments.

export function tokenize(text) {
  return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function encodeVarints(nums) {
  const bytes = [];
  for (const n of nums) {
    let v = n >>> 0;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

function decodeVarints(buf) {
  const out = [];
  let cur = 0;
  let shift = 0;
  for (const b of buf) {
    cur |= (b & 0x7f) << shift;
    if (b < 0x80) {
      out.push(cur >>> 0);
      cur = 0;
      shift = 0;
    } else {
      shift += 7;
    }
  }
  return out;
}

// Delta-encode a sorted ascending list of non-negative integers.
function deltaEncode(sorted) {
  const out = [];
  let prev = 0;
  for (const n of sorted) {
    out.push(n - prev);
    prev = n;
  }
  return out;
}

function deltaDecode(deltas) {
  const out = [];
  let acc = 0;
  for (const d of deltas) {
    acc += d;
    out.push(acc);
  }
  return out;
}

export function compressPositions(positions) {
  const sorted = [...positions].sort((a, b) => a - b);
  return encodeVarints(deltaEncode(sorted)).toString('base64');
}

export function decompressPositions(base64) {
  return deltaDecode(decodeVarints(Buffer.from(base64, 'base64')));
}

export class PositionalIndex {
  constructor() {
    // term -> Map(docId -> number[] positions)
    this.terms = new Map();
    this.docs = new Set();
  }

  static postingsFor(text) {
    const postings = new Map();
    tokenize(text).forEach((term, pos) => {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(pos);
    });
    return postings;
  }

  add(docId, text) {
    this.remove(docId);
    this.docs.add(docId);
    for (const [term, positions] of PositionalIndex.postingsFor(text)) {
      if (!this.terms.has(term)) this.terms.set(term, new Map());
      this.terms.get(term).set(docId, positions);
    }
  }

  remove(docId) {
    if (!this.docs.has(docId)) return;
    this.docs.delete(docId);
    for (const [term, posting] of this.terms) {
      posting.delete(docId);
      if (posting.size === 0) this.terms.delete(term);
    }
  }

  // Exact phrase query: returns sorted docIds containing the phrase
  // as consecutive tokens.
  search(phrase) {
    const terms = tokenize(phrase);
    if (terms.length === 0) return [];
    const first = this.terms.get(terms[0]);
    if (!first) return [];
    let candidates = new Set(first.keys());
    const postings = [first];
    for (let i = 1; i < terms.length; i++) {
      const p = this.terms.get(terms[i]);
      if (!p) return [];
      postings.push(p);
      for (const docId of candidates) {
        if (!p.has(docId)) candidates.delete(docId);
      }
      if (candidates.size === 0) return [];
    }
    const result = [];
    for (const docId of candidates) {
      const startPositions = postings[0].get(docId);
      const restSets = postings.slice(1).map((p) => new Set(p.get(docId)));
      const hit = startPositions.some((start) =>
        restSets.every((set, i) => set.has(start + i + 1))
      );
      if (hit) result.push(docId);
    }
    return result.sort();
  }

  // Serialize one document's postings into compressed segment form.
  static encodeDoc(docId, state, text) {
    const terms = {};
    for (const [term, positions] of PositionalIndex.postingsFor(text)) {
      terms[term] = compressPositions(positions);
    }
    return { docId, state, terms };
  }

  // Apply a persisted segment: { docs: { docId: { state, terms } } }.
  // Later segments override earlier ones; non-active docs are removed.
  applySegment(segment) {
    for (const [docId, doc] of Object.entries(segment.docs || {})) {
      this.remove(docId);
      if (doc.state !== 'active') continue;
      this.docs.add(docId);
      for (const [term, base64] of Object.entries(doc.terms || {})) {
        if (!this.terms.has(term)) this.terms.set(term, new Map());
        this.terms.get(term).set(docId, decompressPositions(base64));
      }
    }
  }

  // Produce a merged segment containing exactly the given active docs.
  toSegment(activeDocs) {
    const docs = {};
    for (const { id, text } of activeDocs) {
      const encoded = PositionalIndex.encodeDoc(id, 'active', text);
      docs[id] = { state: 'active', terms: encoded.terms };
    }
    return { docs };
  }

  get size() {
    return this.docs.size;
  }
}
