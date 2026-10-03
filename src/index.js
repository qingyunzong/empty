import fs from 'node:fs';
import path from 'node:path';
import { tokenize, sameParagraph } from './tokenize.js';
import { encodePostings, PostingsCursor } from './postings.js';
import { computeRootHash, hashCert, verifyChain } from './cert.js';
import { parseQuery } from './query.js';
import { IndexError, E_CERT } from './errors.js';

// Ranking: phrase hit count desc, then min span asc, then docID asc.
// The docID tiebreak makes ordering total, hence stable for ties.
export function compareResults(a, b) {
  return (
    b.hits - a.hits ||
    a.minSpan - b.minSpan ||
    (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0)
  );
}

export class AlarmIndex {
  constructor() {
    this.docs = new Map(); // extId -> { intId, text, tokens, paragraphs }
    this.intToExt = new Map(); // intId -> extId
    this.nextIntId = 1;
    this.deleted = new Set(); // tombstoned intIds, filtered at query time
    this.deletionCount = 0; // cumulative deletions applied by compact
    this.certs = [];
    this.dictionary = []; // sorted [{ term, termId, numDocs, numPositions, blocks }]
    this.termIndex = new Map(); // term -> dictionary entry
    this.postingsBin = Buffer.alloc(0);
    this._dirty = false;
  }

  addDocument(extId, text) {
    if (this.docs.has(extId)) throw new Error(`duplicate document: ${extId}`);
    const { tokens, paragraphs } = tokenize(text);
    const intId = this.nextIntId;
    this.nextIntId += 1;
    this.docs.set(extId, { intId, text, tokens, paragraphs });
    this.intToExt.set(intId, extId);
    this._dirty = true;
    return intId;
  }

  // Incremental invalidation: lays a tombstone; postings stay untouched
  // until the next compact, but queries filter the doc out immediately.
  deleteDocument(extId) {
    const doc = this.docs.get(extId);
    if (!doc) throw new Error(`unknown document: ${extId}`);
    if (this.deleted.has(doc.intId)) throw new Error(`already deleted: ${extId}`);
    this.deleted.add(doc.intId);
  }

  _rebuild() {
    const termMap = new Map(); // term -> Map(intId -> positions[])
    for (const { intId, tokens } of this.docs.values()) {
      tokens.forEach((term, pos) => {
        let per = termMap.get(term);
        if (!per) termMap.set(term, (per = new Map()));
        let arr = per.get(intId);
        if (!arr) per.set(intId, (arr = []));
        arr.push(pos);
      });
    }
    const terms = [...termMap.keys()].sort();
    const chunks = [];
    let offset = 0;
    this.dictionary = [];
    this.termIndex = new Map();
    terms.forEach((term, termId) => {
      const per = termMap.get(term);
      const entries = [...per.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([docId, positions]) => ({ docId, positions }));
      const { data, blocks } = encodePostings(entries);
      for (const b of blocks) b.offset += offset;
      const numPositions = entries.reduce((s, e) => s + e.positions.length, 0);
      const entry = { term, termId, numDocs: entries.length, numPositions, blocks };
      this.dictionary.push(entry);
      this.termIndex.set(term, entry);
      chunks.push(data);
      offset += data.length;
    });
    this.postingsBin = Buffer.concat(chunks);
    this._dirty = false;
  }

  _ensureBuilt() {
    if (this._dirty) this._rebuild();
  }

  _cursor(term) {
    const entry = this.termIndex.get(term);
    if (!entry) return null;
    return new PostingsCursor(this.postingsBin, entry.blocks);
  }

  // Physically drops tombstoned docs, rebuilds postings, and issues a
  // certificate committing to term count, deletion count and root hash.
  compact() {
    for (const intId of this.deleted) {
      const extId = this.intToExt.get(intId);
      this.docs.delete(extId);
      this.intToExt.delete(intId);
    }
    this.deletionCount += this.deleted.size;
    this.deleted.clear();
    this._dirty = true;
    this._rebuild();
    return this._issueCert();
  }

  _termEntries() {
    this._ensureBuilt();
    return this.dictionary.map((d) => {
      const cursor = new PostingsCursor(this.postingsBin, d.blocks);
      const entries = [];
      let e;
      while ((e = cursor.next())) entries.push([e.docId, e.positions]);
      return { term: d.term, entries };
    });
  }

  _issueCert() {
    const cert = {
      seq: this.certs.length,
      termCount: this.dictionary.length,
      docCount: this.docs.size,
      deletionCount: this.deletionCount,
      rootHash: computeRootHash(this._termEntries()),
      prevHash: this.certs.length ? hashCert(this.certs[this.certs.length - 1]) : null,
    };
    this.certs.push(cert);
    return cert;
  }

  verifyCert() {
    if (this.certs.length === 0) {
      throw new IndexError(E_CERT, 'no certificate issued yet');
    }
    verifyChain(this.certs);
    const latest = this.certs[this.certs.length - 1];
    if (computeRootHash(this._termEntries()) !== latest.rootHash) {
      throw new IndexError(E_CERT, 'root hash mismatch against latest certificate');
    }
    if (latest.termCount !== this.dictionary.length) {
      throw new IndexError(E_CERT, 'term count mismatch against latest certificate');
    }
    if (latest.deletionCount !== this.deletionCount) {
      throw new IndexError(E_CERT, 'deletion count mismatch against latest certificate');
    }
    return true;
  }

  query(input) {
    const parsed = parseQuery(input);
    this._ensureBuilt();
    let results;
    if (parsed.type === 'term') results = this._execTerm(parsed.term);
    else if (parsed.type === 'phrase') results = this._execPhrase(parsed.tokens);
    else results = this._execNear(parsed.a, parsed.b, parsed.k);
    return results
      .filter((r) => !this.deleted.has(r.intId)) // tombstone filtering
      .map((r) => ({ docId: this.intToExt.get(r.intId), hits: r.hits, minSpan: r.minSpan }))
      .sort(compareResults);
  }

  _execTerm(term) {
    const cursor = this._cursor(term);
    if (!cursor) return [];
    const results = [];
    let e;
    while ((e = cursor.next())) {
      results.push({ intId: e.docId, hits: e.positions.length, minSpan: 1 });
    }
    return results;
  }

  _execPhrase(tokens) {
    const entries = tokens.map((t) => this.termIndex.get(t));
    if (entries.some((e) => !e)) return [];
    const order = tokens.map((_, i) => i).sort((a, b) => entries[a].numDocs - entries[b].numDocs);
    const mainIdx = order[0];
    const mainCursor = this._cursor(tokens[mainIdx]);
    const others = order.slice(1).map((i) => ({ i, cursor: this._cursor(tokens[i]) }));
    const n = tokens.length;
    const results = [];
    outer: while (true) {
      const main = mainCursor.next();
      if (!main) break;
      const docId = main.docId;
      const posLists = [];
      posLists[mainIdx] = main.positions;
      for (const o of others) {
        const e = o.cursor.advance(docId); // block-level skip
        if (!e || e.docId !== docId) continue outer;
        posLists[o.i] = e.positions;
      }
      if (this.deleted.has(docId)) continue;
      const doc = this.docs.get(this.intToExt.get(docId));
      const sets = posLists.map((p) => new Set(p));
      let hits = 0;
      for (const p of posLists[0]) {
        let ok = true;
        for (let j = 1; j < n; j += 1) {
          if (!sets[j].has(p + j)) { ok = false; break; }
        }
        if (ok && sameParagraph(doc.paragraphs, p, p + n - 1)) hits += 1;
      }
      if (hits > 0) results.push({ intId: docId, hits, minSpan: n });
    }
    return results;
  }

  _execNear(a, b, k) {
    if (!this.termIndex.get(a) || !this.termIndex.get(b)) return [];
    const ca = this._cursor(a);
    const cb = this._cursor(b);
    const results = [];
    let x;
    while ((x = ca.next())) {
      const y = cb.advance(x.docId);
      if (!y || y.docId !== x.docId) continue;
      if (this.deleted.has(x.docId)) continue;
      const doc = this.docs.get(this.intToExt.get(x.docId));
      let hits = 0;
      let minSpan = Infinity;
      for (const pa of x.positions) {
        for (const pb of y.positions) {
          if (pa === pb) continue;
          const dist = Math.abs(pa - pb);
          if (dist - 1 > k) continue; // more than k words between
          if (!sameParagraph(doc.paragraphs, Math.min(pa, pb), Math.max(pa, pb))) continue;
          hits += 1;
          if (dist + 1 < minSpan) minSpan = dist + 1;
        }
      }
      if (hits > 0) results.push({ intId: x.docId, hits, minSpan });
    }
    return results;
  }

  save(dir) {
    this._ensureBuilt();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'postings.bin'), this.postingsBin);
    fs.writeFileSync(path.join(dir, 'terms.json'), `${JSON.stringify(this.dictionary, null, 1)}\n`);
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      `${JSON.stringify(
        {
          version: 1,
          nextIntId: this.nextIntId,
          deletionCount: this.deletionCount,
          deleted: [...this.deleted],
          docs: [...this.docs.entries()].map(([id, d]) => ({
            id,
            intId: d.intId,
            text: d.text,
            paragraphs: d.paragraphs,
          })),
          certs: this.certs,
        },
        null,
        1,
      )}\n`,
    );
  }

  static load(dir) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const idx = new AlarmIndex();
    idx.nextIntId = meta.nextIntId;
    idx.deletionCount = meta.deletionCount;
    idx.deleted = new Set(meta.deleted);
    idx.certs = meta.certs;
    for (const d of meta.docs) {
      const { tokens } = tokenize(d.text);
      idx.docs.set(d.id, { intId: d.intId, text: d.text, tokens, paragraphs: d.paragraphs });
      idx.intToExt.set(d.intId, d.id);
    }
    idx.postingsBin = fs.readFileSync(path.join(dir, 'postings.bin'));
    idx.dictionary = JSON.parse(fs.readFileSync(path.join(dir, 'terms.json'), 'utf8'));
    idx.termIndex = new Map(idx.dictionary.map((e) => [e.term, e]));
    idx._dirty = false;
    return idx;
  }
}
