const TOKEN_RE = /[\p{L}\p{N}]+/gu;

export function tokenize(text) {
  return String(text).toLowerCase().match(TOKEN_RE) ?? [];
}

export class TextIndex {
  #postings = new Map();
  #docTerms = new Map();

  add(docId, text) {
    if (this.#docTerms.has(docId)) {
      throw new Error(`duplicate index doc: ${docId}`);
    }
    const tokens = tokenize(text);
    const terms = new Set();
    tokens.forEach((token, position) => {
      terms.add(token);
      let bucket = this.#postings.get(token);
      if (!bucket) {
        bucket = new Map();
        this.#postings.set(token, bucket);
      }
      let list = bucket.get(docId);
      if (!list) {
        list = [];
        bucket.set(docId, list);
      }
      list.push(position);
    });
    this.#docTerms.set(docId, [...terms]);
  }

  remove(docId) {
    const terms = this.#docTerms.get(docId);
    if (!terms) return false;
    for (const term of terms) {
      const bucket = this.#postings.get(term);
      bucket.delete(docId);
      if (bucket.size === 0) this.#postings.delete(term);
    }
    this.#docTerms.delete(docId);
    return true;
  }

  get termCount() {
    return this.#postings.size;
  }

  get docCount() {
    return this.#docTerms.size;
  }

  postings(term) {
    const bucket = this.#postings.get(String(term).toLowerCase());
    if (!bucket) return {};
    return Object.fromEntries([...bucket.entries()].map(([id, pos]) => [id, [...pos]]));
  }

  phrase(phrase) {
    const terms = Array.isArray(phrase)
      ? phrase.map((t) => String(t).toLowerCase())
      : tokenize(phrase);
    const hits = new Map();
    if (terms.length === 0) return hits;
    let candidates = null;
    for (const term of terms) {
      const bucket = this.#postings.get(term);
      if (!bucket) return hits;
      if (candidates === null) {
        candidates = new Set(bucket.keys());
      } else {
        for (const id of [...candidates]) {
          if (!bucket.has(id)) candidates.delete(id);
        }
      }
      if (candidates.size === 0) return hits;
    }
    for (const id of candidates) {
      const starts = [];
      const first = this.#postings.get(terms[0]).get(id);
      for (const pos of first) {
        let ok = true;
        for (let i = 1; i < terms.length; i++) {
          const list = this.#postings.get(terms[i]).get(id);
          if (!list.includes(pos + i)) {
            ok = false;
            break;
          }
        }
        if (ok) starts.push(pos);
      }
      if (starts.length > 0) hits.set(id, starts);
    }
    return hits;
  }

  near(termA, termB, k) {
    const a = String(termA).toLowerCase();
    const b = String(termB).toLowerCase();
    if (!Number.isInteger(k) || k < 1) {
      throw new Error(`near distance k must be a positive integer, got ${k}`);
    }
    const hits = new Map();
    const bucketA = this.#postings.get(a);
    const bucketB = this.#postings.get(b);
    if (!bucketA || !bucketB) return hits;
    for (const [id, positionsA] of bucketA) {
      const positionsB = bucketB.get(id);
      if (!positionsB) continue;
      const pairs = [];
      for (const pa of positionsA) {
        for (const pb of positionsB) {
          const distance = pb - pa;
          if (distance >= 1 && distance <= k) pairs.push([pa, pb]);
        }
      }
      if (pairs.length > 0) hits.set(id, pairs);
    }
    return hits;
  }

  equals(other) {
    if (this.#postings.size !== other.#postings.size) return false;
    for (const [term, bucket] of this.#postings) {
      const otherBucket = other.#postings.get(term);
      if (!otherBucket || otherBucket.size !== bucket.size) return false;
      for (const [docId, positions] of bucket) {
        const otherPositions = otherBucket.get(docId);
        if (!otherPositions || otherPositions.length !== positions.length) return false;
        for (let i = 0; i < positions.length; i++) {
          if (otherPositions[i] !== positions[i]) return false;
        }
      }
    }
    return true;
  }
}
