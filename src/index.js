import { createHash } from 'node:crypto';
import { tokenize, compileTerm } from './tokenize.js';

export class IndexError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function imageFromTokens(tokens) {
  const image = {};
  for (const { term, pos } of tokens) {
    if (!image[term]) image[term] = [];
    image[term].push(pos);
  }
  return image;
}

function compareSpans(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// Positional inverted index: term -> docKey -> sorted positions.
// Deletions are applied as null images (tombstones) by the store layer.
export class Index {
  constructor() {
    this.byDoc = new Map(); // docKey -> Map(term -> sorted positions)
    this.postings = new Map(); // term -> Map(docKey -> sorted positions)
  }

  static docKey(id, version) {
    return `${id}${version}`;
  }

  static splitKey(docKey) {
    const at = docKey.lastIndexOf('');
    return { id: docKey.slice(0, at), version: Number(docKey.slice(at + 1)) };
  }

  static imageFromText(text) {
    return imageFromTokens(tokenize(text));
  }

  has(docKey) {
    return this.byDoc.has(docKey);
  }

  docKeys() {
    return [...this.byDoc.keys()].sort();
  }

  getImage(docKey) {
    const image = this.byDoc.get(docKey);
    if (!image) return null;
    const out = {};
    for (const [term, positions] of image) out[term] = [...positions];
    return out;
  }

  // Replace the postings of one document. image === null removes it.
  setImage(docKey, image) {
    const old = this.byDoc.get(docKey);
    if (old) {
      for (const [term] of old) {
        const perDoc = this.postings.get(term);
        perDoc.delete(docKey);
        if (perDoc.size === 0) this.postings.delete(term);
      }
      this.byDoc.delete(docKey);
    }
    if (image == null) return;
    const stored = new Map();
    for (const [term, positions] of Object.entries(image)) {
      const sorted = [...positions].sort((a, b) => a - b);
      stored.set(term, sorted);
      let perDoc = this.postings.get(term);
      if (!perDoc) {
        perDoc = new Map();
        this.postings.set(term, perDoc);
      }
      perDoc.set(docKey, sorted);
    }
    this.byDoc.set(docKey, stored);
  }

  addText(docKey, text) {
    const before = this.getImage(docKey);
    this.setImage(docKey, Index.imageFromText(text));
    return before;
  }

  toObject() {
    const out = {};
    for (const term of [...this.postings.keys()].sort()) {
      const perDoc = this.postings.get(term);
      const docs = {};
      for (const docKey of [...perDoc.keys()].sort()) docs[docKey] = [...perDoc.get(docKey)];
      out[term] = docs;
    }
    return out;
  }

  hash() {
    return sha256hex(canonical(this.toObject()));
  }

  // Map docKey -> sorted start positions where tokenSeq occurs consecutively.
  findOccurrences(tokenSeq) {
    const result = new Map();
    if (tokenSeq.length === 0) return result;
    const first = this.postings.get(tokenSeq[0]);
    if (!first) return result;
    const setCache = new Map(); // term -> Map(docKey -> Set(pos))
    const posSet = (term, docKey) => {
      let perTerm = setCache.get(term);
      if (!perTerm) {
        perTerm = new Map();
        setCache.set(term, perTerm);
      }
      let set = perTerm.get(docKey);
      if (!set) {
        const perDoc = this.postings.get(term);
        set = new Set(perDoc && perDoc.get(docKey) ? perDoc.get(docKey) : []);
        perTerm.set(docKey, set);
      }
      return set;
    };
    for (const [docKey, positions] of first) {
      const starts = [];
      for (const p of positions) {
        let ok = true;
        for (let i = 1; i < tokenSeq.length; i += 1) {
          if (!posSet(tokenSeq[i], docKey).has(p + i)) {
            ok = false;
            break;
          }
        }
        if (ok) starts.push(p);
      }
      if (starts.length > 0) result.set(docKey, starts);
    }
    return result;
  }

  compile(text, what) {
    const seq = compileTerm(text);
    if (seq.length === 0) {
      throw new IndexError('E_PARSE', `${what} contains no searchable tokens`);
    }
    return seq;
  }

  queryTerm(term) {
    const seq = this.compile(term, 'term');
    return this.spanResults(this.findOccurrences(seq), seq.length);
  }

  queryPhrase(phrase) {
    if (typeof phrase !== 'string') throw new IndexError('E_PARSE', 'phrase must be a string');
    const parts = phrase.trim().split(/\s+/).filter((s) => s.length > 0);
    if (parts.length === 0) throw new IndexError('E_PARSE', 'phrase is empty');
    const seq = parts.flatMap((part) => this.compile(part, 'phrase term'));
    return this.spanResults(this.findOccurrences(seq), seq.length);
  }

  queryNear(left, right, k) {
    if (!Number.isInteger(k) || k < 0) throw new IndexError('E_PARSE', 'k must be a non-negative integer');
    const seqA = this.compile(left, 'near term');
    const seqB = this.compile(right, 'near term');
    const occA = this.findOccurrences(seqA);
    const occB = this.findOccurrences(seqB);
    const result = new Map();
    for (const [docKey, startsA] of occA) {
      const startsB = occB.get(docKey);
      if (!startsB) continue;
      const pairs = [];
      for (const sa of startsA) {
        const ea = sa + seqA.length - 1;
        for (const sb of startsB) {
          const eb = sb + seqB.length - 1;
          let gap;
          if (sb > ea) gap = sb - ea - 1;
          else if (sa > eb) gap = sa - eb - 1;
          else gap = 0;
          if (gap <= k) pairs.push([sa, ea, sb, eb]);
        }
      }
      if (pairs.length > 0) {
        pairs.sort(compareSpans);
        result.set(docKey, pairs);
      }
    }
    return this.formatResults(result);
  }

  spanResults(occurrences, spanLen) {
    const matches = new Map();
    for (const [docKey, starts] of occurrences) {
      matches.set(docKey, starts.map((s) => [s, s + spanLen - 1]));
    }
    return this.formatResults(matches);
  }

  // Deterministic ordering: id asc (code units), then version asc.
  formatResults(matches) {
    const rows = [...matches.entries()].map(([docKey, spans]) => {
      const { id, version } = Index.splitKey(docKey);
      return { id, version, matches: spans };
    });
    rows.sort((a, b) => {
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return a.version - b.version;
    });
    return rows;
  }
}
