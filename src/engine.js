import { createHash } from 'node:crypto';
import { tokenize, queryTerms } from './tokenize.js';
import { BLOCK_SIZE, encodeBlock, decodeBlock, PostingCursor } from './postings.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('empty');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256hex(level[i] + right));
    }
    level = next;
  }
  return level[0];
}

export function certHash(cert) {
  return sha256hex(JSON.stringify(cert));
}

function emptyPosting() {
  return { blocks: [], tail: [] };
}

export class Engine {
  constructor() {
    this.docs = new Map(); // docID -> { ext, text }
    this.dict = new Map(); // term -> { blocks, tail }
    this.tombstones = new Set();
    this.deletedCount = 0; // cumulative count purged by compact
    this.nextDocID = 1;
    this.certs = []; // certificate chain
  }

  addDocument(text, ext = null) {
    const docID = this.nextDocID++;
    this.docs.set(docID, { ext: ext ?? `doc-${docID}`, text: String(text) });
    this._indexTokens(docID, tokenize(text));
    return docID;
  }

  _indexTokens(docID, tokens) {
    for (const tok of tokens) {
      let p = this.dict.get(tok.term);
      if (!p) {
        p = emptyPosting();
        this.dict.set(tok.term, p);
      }
      p.tail.push({ doc: docID, pos: tok.pos, para: tok.para });
      if (p.tail.length >= BLOCK_SIZE) {
        p.blocks.push(encodeBlock(p.tail));
        p.tail = [];
      }
    }
  }

  deleteDocument(id) {
    const docID = this._resolveDoc(id);
    if (docID === null) throw new EngineError('E_TOKEN', `unknown document: ${id}`);
    this.tombstones.add(docID);
    return docID;
  }

  _resolveDoc(id) {
    if (/^\d+$/.test(String(id))) {
      const n = Number(id);
      if (this.docs.has(n)) return n;
    }
    for (const [docID, d] of this.docs) if (d.ext === String(id)) return docID;
    return null;
  }

  // Purge tombstoned docs, rebuild the dictionary, issue a certificate.
  compact() {
    for (const docID of this.tombstones) this.docs.delete(docID);
    this.deletedCount += this.tombstones.size;
    this.tombstones.clear();
    this.dict = new Map();
    for (const docID of [...this.docs.keys()].sort((a, b) => a - b)) {
      this._indexTokens(docID, tokenize(this.docs.get(docID).text));
    }
    return this._issueCert();
  }

  _sortedEntries(term) {
    const p = this.dict.get(term);
    if (!p) return [];
    const out = [];
    for (const b of p.blocks) out.push(...decodeBlock(b));
    out.push(...p.tail);
    return out;
  }

  _computeCertFields() {
    const leaves = [];
    for (const term of [...this.dict.keys()].sort()) {
      leaves.push(sha256hex(`T:${term}:${JSON.stringify(this._sortedEntries(term))}`));
    }
    for (const docID of [...this.docs.keys()].sort((a, b) => a - b)) {
      leaves.push(sha256hex(`D:${docID}:${sha256hex(this.docs.get(docID).text)}`));
    }
    return {
      termCount: this.dict.size,
      docCount: this.docs.size,
      deletedCount: this.deletedCount,
      rootHash: merkleRoot(leaves), // root hash over sorted leaves
    };
  }

  _issueCert() {
    const prevHash =
      this.certs.length > 0 ? certHash(this.certs[this.certs.length - 1]) : '0'.repeat(64);
    const cert = { seq: this.certs.length + 1, ...this._computeCertFields(), prevHash };
    this.certs.push(cert);
    return cert;
  }

  // Verify current state against the certificate chain.
  verifyCerts() {
    if (this.certs.length === 0) throw new EngineError('E_CERT', 'no certificate issued yet');
    for (let i = 0; i < this.certs.length; i++) {
      const expectedPrev = i === 0 ? '0'.repeat(64) : certHash(this.certs[i - 1]);
      if (this.certs[i].prevHash !== expectedPrev) {
        throw new EngineError('E_CERT', `cert chain broken at seq ${this.certs[i].seq}`);
      }
    }
    const fresh = this._computeCertFields();
    const latest = this.certs[this.certs.length - 1];
    for (const key of ['termCount', 'docCount', 'deletedCount', 'rootHash']) {
      if (fresh[key] !== latest[key]) {
        throw new EngineError('E_CERT', `certificate mismatch on ${key}`);
      }
    }
    return latest;
  }

  // --- Query ---

  query({ phrase = null, near = null, k = 4 } = {}) {
    if (!Number.isInteger(k) || k < 0) {
      throw new EngineError('E_SPAN', `invalid span k: ${k}`);
    }
    let phraseTerms = null;
    if (phrase !== null && phrase !== undefined) {
      phraseTerms = queryTerms(phrase);
      if (phraseTerms.length === 0) {
        throw new EngineError('E_TOKEN', 'phrase contains no valid terms');
      }
    }
    let nearPair = null;
    if (near) {
      const a = queryTerms(near[0]);
      const b = queryTerms(near[1]);
      if (a.length !== 1 || b.length !== 1) {
        throw new EngineError('E_TOKEN', 'near terms must each be a single non-empty term');
      }
      nearPair = [a[0], b[0]];
    }
    if (!phraseTerms && !nearPair) {
      throw new EngineError('E_TOKEN', 'query has no terms');
    }

    let candidateDocs = null;
    const phraseHitsByDoc = new Map();
    const phraseSpansByDoc = new Map();
    if (phraseTerms) {
      candidateDocs = new Set();
      for (const [doc, hits] of this._phraseMatches(phraseTerms)) {
        candidateDocs.add(doc);
        phraseHitsByDoc.set(doc, hits.length);
        phraseSpansByDoc.set(doc, hits);
      }
    }
    const nearPairsByDoc = new Map();
    if (nearPair) {
      const matches = this._nearMatches(nearPair[0], nearPair[1], k);
      if (candidateDocs === null) candidateDocs = new Set(matches.keys());
      else for (const d of [...candidateDocs]) if (!matches.has(d)) candidateDocs.delete(d);
      for (const [doc, pairs] of matches) nearPairsByDoc.set(doc, pairs);
    }

    const results = [];
    for (const doc of candidateDocs) {
      if (this.tombstones.has(doc)) continue; // tombstone filtering
      const phraseHits = phraseHitsByDoc.get(doc) ?? 0;
      const pairs = nearPairsByDoc.get(doc) ?? [];
      const spans = [];
      if (phraseTerms && nearPair) {
        for (const s of phraseSpansByDoc.get(doc)) {
          for (const p of pairs) {
            spans.push(Math.max(s.end, p.end) - Math.min(s.start, p.start) + 1);
          }
        }
      } else if (phraseTerms) {
        for (const s of phraseSpansByDoc.get(doc)) spans.push(s.end - s.start + 1);
      } else {
        for (const p of pairs) spans.push(p.end - p.start + 1);
      }
      results.push({
        docID: doc,
        ext: this.docs.get(doc).ext,
        phraseHits,
        nearHits: pairs.length,
        minSpan: spans.length ? Math.min(...spans) : 0,
      });
    }
    // Ranking: phrase hits desc, min span asc, docID asc (total order => stable).
    results.sort(
      (a, b) => b.phraseHits - a.phraseHits || a.minSpan - b.minSpan || a.docID - b.docID
    );
    return results;
  }

  _cursorFor(term) {
    const p = this.dict.get(term);
    return p ? new PostingCursor(p) : null;
  }

  _entriesInDoc(cursor, doc) {
    const first = cursor.seekDoc(doc);
    const out = [];
    if (!first || first.doc !== doc) return out;
    let cur = first;
    while (cur && cur.doc === doc) {
      out.push(cur);
      cur = cursor.advance();
    }
    return out;
  }

  // Map doc -> [{start, end}] phrase occurrences.
  _phraseMatches(terms) {
    const cursors = terms.map((t) => this._cursorFor(t));
    if (cursors.some((c) => c === null)) return new Map();
    const counts = terms.map((t) => {
      const p = this.dict.get(t);
      return p.blocks.length * BLOCK_SIZE + p.tail.length;
    });
    const driverIdx = counts.indexOf(Math.min(...counts));
    // Group the rarest term's entries by doc in one forward pass.
    const driver = cursors[driverIdx];
    const byDoc = new Map();
    let cur = driver.current();
    while (cur) {
      let arr = byDoc.get(cur.doc);
      if (!arr) {
        arr = [];
        byDoc.set(cur.doc, arr);
      }
      arr.push(cur);
      cur = driver.advance();
    }
    const result = new Map();
    for (const [doc, driverEntries] of byDoc) {
      const perTerm = [];
      let ok = true;
      for (let i = 0; i < terms.length; i++) {
        const entries = i === driverIdx ? driverEntries : this._entriesInDoc(cursors[i], doc);
        if (entries.length === 0) {
          ok = false;
          break;
        }
        perTerm.push(entries);
      }
      if (!ok) continue;
      const hits = findPhraseOccurrences(perTerm);
      if (hits.length > 0) result.set(doc, hits);
    }
    return result;
  }

  // Map doc -> [{start, end}] proximity pairs (same paragraph, gap <= k).
  _nearMatches(a, b, k) {
    const ca = this._cursorFor(a);
    const cb = this._cursorFor(b);
    const result = new Map();
    if (!ca || !cb) return result;
    let cur = ca.current();
    while (cur) {
      const doc = cur.doc;
      const aEntries = this._entriesInDoc(ca, doc);
      const bEntries = this._entriesInDoc(cb, doc);
      const pairs = [];
      for (const ea of aEntries) {
        for (const eb of bEntries) {
          if (ea.para !== eb.para) continue;
          if (Math.abs(ea.pos - eb.pos) - 1 <= k) {
            pairs.push({ start: Math.min(ea.pos, eb.pos), end: Math.max(ea.pos, eb.pos) });
          }
        }
      }
      if (pairs.length > 0) result.set(doc, pairs);
      cur = ca.current();
    }
    return result;
  }

  // --- Persistence ---

  toJSON() {
    const dict = {};
    for (const term of [...this.dict.keys()].sort()) {
      const p = this.dict.get(term);
      dict[term] = { blocks: p.blocks, tail: p.tail };
    }
    const docs = {};
    for (const docID of [...this.docs.keys()].sort((a, b) => a - b)) {
      docs[docID] = this.docs.get(docID);
    }
    return {
      version: 1,
      nextDocID: this.nextDocID,
      deletedCount: this.deletedCount,
      tombstones: [...this.tombstones].sort((a, b) => a - b),
      docs,
      dict,
      certs: this.certs,
    };
  }

  static fromJSON(data) {
    const e = new Engine();
    e.nextDocID = data.nextDocID;
    e.deletedCount = data.deletedCount;
    e.tombstones = new Set(data.tombstones);
    for (const [id, d] of Object.entries(data.docs)) e.docs.set(Number(id), d);
    for (const [term, p] of Object.entries(data.dict)) {
      e.dict.set(term, { blocks: p.blocks, tail: p.tail });
    }
    e.certs = data.certs ?? [];
    return e;
  }
}

function findPhraseOccurrences(perTerm) {
  const n = perTerm.length;
  const maps = perTerm.map((entries) => {
    const m = new Map();
    for (const e of entries) m.set(e.pos, e.para);
    return m;
  });
  const hits = [];
  for (const e of perTerm[0]) {
    let ok = true;
    for (let i = 1; i < n; i++) {
      if (maps[i].get(e.pos + i) !== e.para) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ start: e.pos, end: e.pos + n - 1 });
  }
  return hits;
}
