// Compressed positional inverted index over node `terms` text.
// In memory the postings are kept decoded for incremental updates;
// at the persistence boundary they are delta + varint compressed.

const TOKEN_RE = /[A-Za-z0-9]+|[一-鿿]/g;

export function tokenize(text) {
  const tokens = [];
  const re = new RegExp(TOKEN_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    tokens.push(m[0].toLowerCase());
  }
  return tokens;
}

export function encodeVarints(nums) {
  const bytes = [];
  for (const n of nums) {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(`varint expects non-negative integer, got ${n}`);
    }
    let v = n;
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(v);
  }
  return Buffer.from(bytes);
}

export function decodeVarints(buf, count) {
  const out = [];
  let shift = 0;
  let value = 0;
  let offset = 0;
  while (out.length < count) {
    if (offset >= buf.length) throw new Error('truncated varint stream');
    const b = buf[offset++];
    value += (b & 0x7f) * 2 ** shift;
    if (b & 0x80) {
      shift += 7;
    } else {
      out.push(value);
      value = 0;
      shift = 0;
    }
  }
  return { values: out, offset };
}

// Layout: termCount, then per term:
//   termLen, termBytes, docCount, then per doc:
//   docIdDelta, posCount, posDelta*  (first pos stored absolute)
export function encodePostings(postings) {
  const terms = [...postings.keys()].sort();
  const parts = [encodeVarints([terms.length])];
  for (const term of terms) {
    const docs = postings.get(term);
    const docIds = [...docs.keys()].sort((a, b) => a - b);
    const termBuf = Buffer.from(term, 'utf8');
    const nums = [];
    let prevDoc = 0;
    for (const docId of docIds) {
      nums.push(docId - prevDoc);
      prevDoc = docId;
      const positions = docs.get(docId);
      nums.push(positions.length);
      let prevPos = 0;
      for (const p of positions) {
        nums.push(p - prevPos);
        prevPos = p;
      }
    }
    parts.push(encodeVarints([termBuf.length, docIds.length]), termBuf, encodeVarints(nums));
  }
  return Buffer.concat(parts);
}

export function decodePostings(buf) {
  const postings = new Map();
  let offset = 0;
  const read = (count) => {
    const { values, offset: used } = decodeVarints(buf.subarray(offset), count);
    offset += used;
    return values;
  };
  const [termCount] = read(1);
  for (let t = 0; t < termCount; t++) {
    const [termLen, docCount] = read(2);
    const term = buf.subarray(offset, offset + termLen).toString('utf8');
    offset += termLen;
    const docs = new Map();
    let prevDoc = 0;
    for (let d = 0; d < docCount; d++) {
      const [docDelta, posCount] = read(2);
      const docId = prevDoc + docDelta;
      prevDoc = docId;
      const deltas = read(posCount);
      const positions = [];
      let prevPos = 0;
      for (const delta of deltas) {
        prevPos += delta;
        positions.push(prevPos);
      }
      docs.set(docId, positions);
    }
    postings.set(term, docs);
  }
  return postings;
}

export class PositionalIndex {
  constructor() {
    this.postings = new Map(); // term -> Map<docId, number[]>
    this.docIds = new Map(); // nodeId -> docId
    this.nodeIds = []; // docId -> nodeId (null holes after removal)
  }

  addDocument(nodeId, text) {
    if (this.docIds.has(nodeId)) this.removeDocument(nodeId);
    const docId = this.nodeIds.length;
    this.docIds.set(nodeId, docId);
    this.nodeIds.push(nodeId);
    const byTerm = new Map();
    tokenize(text).forEach((tok, pos) => {
      if (!byTerm.has(tok)) byTerm.set(tok, []);
      byTerm.get(tok).push(pos);
    });
    for (const [term, positions] of byTerm) {
      if (!this.postings.has(term)) this.postings.set(term, new Map());
      this.postings.get(term).set(docId, positions);
    }
  }

  removeDocument(nodeId) {
    const docId = this.docIds.get(nodeId);
    if (docId === undefined) return false;
    for (const [term, docs] of this.postings) {
      if (docs.delete(docId) && docs.size === 0) this.postings.delete(term);
    }
    this.docIds.delete(nodeId);
    this.nodeIds[docId] = null;
    return true;
  }

  hasNode(nodeId) {
    return this.docIds.has(nodeId);
  }

  phrase(query) {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const first = this.postings.get(terms[0]);
    if (!first) return [];
    const results = [];
    for (const [docId, positions] of first) {
      const matched = [];
      for (const p of positions) {
        let ok = true;
        for (let i = 1; i < terms.length; i++) {
          const arr = this.postings.get(terms[i])?.get(docId);
          if (!arr || !arr.includes(p + i)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          for (let i = 0; i < terms.length; i++) matched.push(p + i);
        }
      }
      if (matched.length) {
        results.push({ nodeId: this.nodeIds[docId], positions: matched });
      }
    }
    return results.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
  }

  // First window of k consecutive token positions covering all query terms.
  near(query, k = 5) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || k < terms.length) return [];
    let candidates = null;
    for (const term of terms) {
      const docs = this.postings.get(term);
      if (!docs) return [];
      candidates = candidates === null
        ? new Set(docs.keys())
        : new Set([...candidates].filter((d) => docs.has(d)));
    }
    const results = [];
    for (const docId of candidates) {
      const lists = terms.map((t) => this.postings.get(t).get(docId));
      const min = Math.min(...lists.map((l) => l[0]));
      const max = Math.max(...lists.map((l) => l[l.length - 1]));
      for (let start = min; start <= max; start++) {
        const end = start + k;
        if (lists.every((l) => l.some((p) => p >= start && p < end))) {
          const hits = new Set();
          for (const l of lists) {
            for (const p of l) if (p >= start && p < end) hits.add(p);
          }
          results.push({
            nodeId: this.nodeIds[docId],
            positions: [...hits].sort((a, b) => a - b),
          });
          break;
        }
      }
    }
    return results.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
  }

  serialize() {
    return {
      docs: [...this.docIds.entries()],
      postings: encodePostings(this.postings).toString('base64'),
    };
  }

  static deserialize(data) {
    const index = new PositionalIndex();
    index.postings = decodePostings(Buffer.from(data.postings, 'base64'));
    let maxDoc = -1;
    for (const [nodeId, docId] of data.docs) {
      index.docIds.set(nodeId, docId);
      maxDoc = Math.max(maxDoc, docId);
    }
    index.nodeIds = new Array(maxDoc + 1).fill(null);
    for (const [nodeId, docId] of data.docs) {
      index.nodeIds[docId] = nodeId;
    }
    return index;
  }
}
