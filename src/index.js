'use strict';
// Positional inverted index with field bits + deletion-neighborhood code index.

import { Bitmap } from './bitmap.js';
import { tokenize, normalizeCode, deletions, editDistanceLE1 } from './text.js';

export const FIELD = { DESC: 1, DEFECT: 2, BATCH: 4 };

export class InvertedIndex {
  constructor() {
    this.docs = new Map();      // id -> record
    this.docNos = new Map();    // id -> internal number
    this.byNo = [];             // no -> record (null after removal)
    this.postings = new Map();  // term -> Map<no, {fields, positions}>
    this.batches = new Map();   // batchId -> Set<id>
    this.nextNo = 0;
  }

  _post(term, no) {
    let m = this.postings.get(term);
    if (!m) {
      m = new Map();
      this.postings.set(term, m);
    }
    let p = m.get(no);
    if (!p) {
      p = { fields: 0, positions: [] };
      m.set(no, p);
    }
    return p;
  }

  addDocument(doc) {
    if (this.docs.has(doc.id)) {
      const err = new Error('duplicate doc id: ' + doc.id);
      err.code = 'E_DUP';
      throw err;
    }
    const no = this.nextNo++;
    const rec = {
      no,
      id: String(doc.id),
      batchId: String(doc.batchId),
      description: String(doc.description ?? ''),
      defectCodeN: normalizeCode(doc.defectCode ?? ''),
      batchCodeN: normalizeCode(doc.batchCode ?? ''),
      termRefs: [],
    };
    for (const { term, pos } of tokenize(rec.description)) {
      const key = 't:' + term;
      const p = this._post(key, no);
      p.fields |= FIELD.DESC;
      p.positions.push(pos);
      rec.termRefs.push(key);
    }
    for (const [code, bit] of [[rec.defectCodeN, FIELD.DEFECT], [rec.batchCodeN, FIELD.BATCH]]) {
      if (!code) continue;
      for (const del of deletions(code)) {
        const key = 'd:' + del;
        this._post(key, no).fields |= bit;
        rec.termRefs.push(key + (bit === FIELD.DEFECT ? '#' : '@'));
      }
    }
    this.docs.set(rec.id, rec);
    this.docNos.set(rec.id, no);
    this.byNo[no] = rec;
    let b = this.batches.get(rec.batchId);
    if (!b) {
      b = new Set();
      this.batches.set(rec.batchId, b);
    }
    b.add(rec.id);
    return rec;
  }

  // Incremental removal: postings and doc tables updated in place.
  removeBatch(batchId) {
    const ids = this.batches.get(batchId);
    if (!ids) return null;
    const removed = [];
    for (const id of ids) {
      const rec = this.docs.get(id);
      for (const ref of rec.termRefs) {
        const key = ref.endsWith('#') || ref.endsWith('@') ? ref.slice(0, -1) : ref;
        const m = this.postings.get(key);
        if (m) {
          m.delete(rec.no);
          if (m.size === 0) this.postings.delete(key);
        }
      }
      this.docs.delete(id);
      this.docNos.delete(id);
      this.byNo[rec.no] = null;
      removed.push(id);
    }
    this.batches.delete(batchId);
    return removed.sort();
  }

  _phraseHits(phraseTokens) {
    const out = new Bitmap();
    if (!phraseTokens.length) return out;
    const maps = phraseTokens.map((t) => this.postings.get('t:' + t));
    if (maps.some((m) => !m)) return out;
    const descNos = (m) => [...m].filter(([, v]) => v.fields & FIELD.DESC).map(([no]) => no);
    let common = descNos(maps[0]);
    for (let k = 1; k < maps.length; k++) {
      const s = new Set(descNos(maps[k]));
      common = common.filter((no) => s.has(no));
    }
    for (const no of common) {
      const posSets = maps.map((m) => new Set(m.get(no).positions));
      const starts = posSets[0];
      for (const p of starts) {
        let ok = true;
        for (let k = 1; k < posSets.length && ok; k++) ok = posSets[k].has(p + k);
        if (ok) {
          out.add(no);
          break;
        }
      }
    }
    return out;
  }

  _codeHits(code, bit) {
    const out = new Bitmap();
    const q = normalizeCode(code);
    if (!q) return out;
    const candidates = new Set();
    for (const del of deletions(q)) {
      const m = this.postings.get('d:' + del);
      if (m) for (const [no, v] of m) if (v.fields & bit) candidates.add(no);
    }
    for (const no of candidates) {
      const rec = this.byNo[no];
      if (!rec) continue;
      const stored = bit === FIELD.DEFECT ? rec.defectCodeN : rec.batchCodeN;
      if (editDistanceLE1(stored, q)) out.add(no);
    }
    return out;
  }

  // nq: result of normalizeQuery. Conditions are OR-ed.
  search(nq) {
    let out = new Bitmap();
    if (nq.phraseTokens.length) out = out.or(this._phraseHits(nq.phraseTokens));
    if (nq.defectCode) out = out.or(this._codeHits(nq.defectCode, FIELD.DEFECT));
    if (nq.batchCode) out = out.or(this._codeHits(nq.batchCode, FIELD.BATCH));
    return out;
  }

  // Independent brute-force matcher (oracle for tests/audits).
  bruteForce(nq) {
    const out = new Bitmap();
    for (const rec of this.docs.values()) {
      let match = false;
      if (nq.phraseTokens.length) {
        const toks = tokenize(rec.description);
        const posOf = new Map();
        for (const t of toks) {
          if (!posOf.has(t.term)) posOf.set(t.term, new Set());
          posOf.get(t.term).add(t.pos);
        }
        const first = posOf.get(nq.phraseTokens[0]);
        if (first) {
          for (const p of first) {
            let ok = true;
            for (let k = 1; k < nq.phraseTokens.length && ok; k++) {
              const s = posOf.get(nq.phraseTokens[k]);
              ok = !!s && s.has(p + k);
            }
            if (ok) { match = true; break; }
          }
        }
      }
      if (!match && nq.defectCode && editDistanceLE1(rec.defectCodeN, nq.defectCode)) match = true;
      if (!match && nq.batchCode && editDistanceLE1(rec.batchCodeN, nq.batchCode)) match = true;
      if (match) out.add(rec.no);
    }
    return out;
  }
}
