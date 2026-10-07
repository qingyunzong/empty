'use strict';

const { Bitmap } = require('./bitmap');
const { sha256hex, hashCanonical, hashHitIds } = require('./hash');
const { RecallError, E_EPOCH, E_DUP, E_PROOF } = require('./errors');

const FIELD_DESC = 1; // description text
const FIELD_CODE = 2; // defect code
const FIELD_BATCH = 4; // batch code
const FIELD_NAMES = { [FIELD_DESC]: 'desc', [FIELD_CODE]: 'code', [FIELD_BATCH]: 'batch' };

const DEFAULT_PHRASE = ['裂纹', '扩展'];
const DEFAULT_NEAR_WINDOW = 4;

// Split text into tokens with char offsets. CJK text is indexed as
// overlapping bigrams (dictionary-free segmentation); alnum runs stay whole.
function tokenize(text) {
  const tokens = [];
  const re = /[一-鿿]+|[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m[0];
    if (/^[一-鿿]/.test(s)) {
      if (s.length === 1) {
        tokens.push({ term: s, pos: m.index });
      } else {
        for (let i = 0; i < s.length - 1; i++) {
          tokens.push({ term: s.slice(i, i + 2), pos: m.index + i });
        }
      }
    } else {
      tokens.push({ term: s, pos: m.index });
    }
  }
  return tokens;
}

const CJK_RUN = /^[一-鿿]+$/;

function normalizeQuery(q) {
  const phrase = (q.phrase && q.phrase.length ? q.phrase : DEFAULT_PHRASE).map(String);
  const window = Number.isInteger(q.window) && q.window > 0 ? q.window : DEFAULT_NEAR_WINDOW;
  return { phrase, window };
}

function queryNormHash(norm) {
  return hashCanonical({ q: norm });
}

function stateHash(index, epoch) {
  return hashCanonical({
    epoch,
    docs: [...index.docs.keys()].sort((a, b) => a - b),
    batches: [...index.batches.keys()].sort(),
  });
}

class Store {
  constructor() {
    this.index = {
      docs: new Map(), // id -> { desc, code, batch }
      batches: new Map(), // batch -> Set<id>
      postings: new Map(), // term -> Map<fieldBit, Map<docId, number[]>>
      nextId: 1,
    };
    this.epoch = 0;
    this.epochStates = new Map([[0, stateHash(this.index, 0)]]);
    this.recalls = new Map(); // recallId -> record
    this.ledger = []; // causal chain, append-only
    this._commit('genesis', { note: 'index initialized' });
  }

  _commit(type, data) {
    const prevHash = this.ledger.length ? this.ledger[this.ledger.length - 1].hash : '0'.repeat(64);
    const entry = {
      seq: this.ledger.length,
      epoch: this.epoch,
      type,
      data,
      prevHash,
    };
    entry.hash = sha256hex('entry:' + hashCanonical(entry));
    this.ledger.push(entry);
    return entry;
  }

  _bumpEpoch(type, data) {
    this.epoch++;
    this.epochStates.set(this.epoch, stateHash(this.index, this.epoch));
    return this._commit(type, data);
  }

  _addPosting(term, field, docId, pos) {
    let byField = this.index.postings.get(term);
    if (!byField) {
      byField = new Map();
      this.index.postings.set(term, byField);
    }
    let byDoc = byField.get(field);
    if (!byDoc) {
      byDoc = new Map();
      byField.set(field, byDoc);
    }
    let positions = byDoc.get(docId);
    if (!positions) {
      positions = [];
      byDoc.set(docId, positions);
    }
    positions.push(pos);
  }

  _removePosting(term, field, docId) {
    const byField = this.index.postings.get(term);
    if (!byField) return;
    const byDoc = byField.get(field);
    if (!byDoc) return;
    byDoc.delete(docId);
    if (byDoc.size === 0) byField.delete(field);
    if (byField.size === 0) this.index.postings.delete(term);
  }

  // Postings (docId -> start positions) for an arbitrary term in a field.
  // Terms longer than one indexed token (e.g. 3+ char CJK words) are
  // resolved by intersecting their bigram postings at consecutive offsets.
  _termPostings(term, field) {
    // Whole-token postings first (covers alnum tokens, <=2 char CJK, and
    // code/batch fields which are indexed as whole values).
    const direct = this.index.postings.get(term)?.get(field);
    if (direct) return new Map(direct);
    if (!CJK_RUN.test(term) || term.length <= 2) return null;
    let result = null;
    for (let i = 0; i < term.length - 1; i++) {
      const post = this.index.postings.get(term.slice(i, i + 2))?.get(field);
      if (!post) return null;
      if (result === null) {
        result = new Map();
        for (const [docId, poss] of post) result.set(docId, poss.map((p) => p - i));
      } else {
        for (const [docId, starts] of result) {
          const poss = post.get(docId);
          if (!poss) {
            result.delete(docId);
            continue;
          }
          const shifted = new Set(poss.map((p) => p - i));
          const kept = starts.filter((s) => shifted.has(s));
          if (kept.length === 0) result.delete(docId);
          else result.set(docId, kept);
        }
      }
    }
    return result;
  }

  // Load defect records. Purely incremental; bumps epoch once.
  load(records) {
    if (!Array.isArray(records) || records.length === 0) {
      throw new RecallError(E_DUP, 'load requires a non-empty array of records');
    }
    const added = [];
    for (const rec of records) {
      const id = this.index.nextId++;
      const doc = { desc: String(rec.desc ?? ''), code: String(rec.code ?? ''), batch: String(rec.batch ?? '') };
      this.index.docs.set(id, doc);
      if (!this.index.batches.has(doc.batch)) this.index.batches.set(doc.batch, new Set());
      this.index.batches.get(doc.batch).add(id);
      for (const { term, pos } of tokenize(doc.desc)) this._addPosting(term, FIELD_DESC, id, pos);
      this._addPosting(doc.code, FIELD_CODE, id, 0);
      this._addPosting(doc.batch, FIELD_BATCH, id, 0);
      added.push(id);
    }
    const entry = this._bumpEpoch('load', { ids: added, count: added.length });
    return { ids: added, epoch: this.epoch, txHash: entry.hash };
  }

  // Incremental deletion of a whole batch: bitmaps (rebuilt recall sets are derived)
  // and the inverted index stay in sync because postings are removed per doc.
  deleteBatch(batch) {
    const ids = this.index.batches.get(batch);
    if (!ids || ids.size === 0) {
      throw new RecallError(E_EPOCH, `unknown batch: ${batch}`);
    }
    for (const id of ids) {
      const doc = this.index.docs.get(id);
      for (const { term } of tokenize(doc.desc)) this._removePosting(term, FIELD_DESC, id);
      this._removePosting(doc.code, FIELD_CODE, id);
      this._removePosting(doc.batch, FIELD_BATCH, id);
      this.index.docs.delete(id);
    }
    this.index.batches.delete(batch);
    const entry = this._bumpEpoch('deleteBatch', { batch, ids: [...ids].sort((a, b) => a - b) });
    return { removed: [...ids].sort((a, b) => a - b), epoch: this.epoch, txHash: entry.hash };
  }

  // Evaluate the recall query against the CURRENT index; returns sorted hit ids
  // and a compressed bitmap of the recall set.
  evaluate(query) {
    const norm = normalizeQuery(query);
    const [t1, t2] = norm.phrase;
    const hits = new Bitmap();

    // Clause A: phrase "t1 t2" in the description field: t2 starts within
    // `window` chars after the end of t1 (ordered near-phrase).
    const desc1 = this._termPostings(t1, FIELD_DESC);
    const desc2 = this._termPostings(t2, FIELD_DESC);
    if (desc1 && desc2) {
      for (const [docId, posList] of desc1) {
        const other = desc2.get(docId);
        if (!other) continue;
        const hit = posList.some((p) =>
          other.some((q) => {
            const gap = q - (p + t1.length);
            return gap >= 0 && gap <= norm.window;
          })
        );
        if (hit) hits.add(docId);
      }
    }

    // Clause B: defect code and batch code postings near each other
    // (same record => both at position 0 of their fields, distance 0 <= window).
    const codeDocs = this._termPostings(t1, FIELD_CODE);
    const batchDocs = this._termPostings(t2, FIELD_BATCH);
    if (codeDocs && batchDocs) {
      for (const docId of codeDocs.keys()) {
        if (batchDocs.has(docId)) hits.add(docId);
      }
    }

    return { norm, hits };
  }

  // Run a recall: idempotent per (query, epoch). Re-issuing the same recall
  // under an unchanged index returns the existing certificate (E_DUP class).
  recall(query, opts = {}) {
    const norm = normalizeQuery(query);
    const qHash = queryNormHash(norm);
    const baseKey = `${qHash}@${this.epoch}`;
    const existing = this._latestRecord(qHash, this.epoch);
    if (existing && !existing.record.revoked) {
      if (opts.force) {
        throw new RecallError(E_DUP, `recall already issued for this query at epoch ${this.epoch}`);
      }
      return { ...existing.record.certificate, recallId: existing.recallId, deduped: true };
    }
    // Re-issue after a revoke: version the id so the revoked record (and the
    // ledger entries pointing at it) stay intact.
    const key = existing ? `${baseKey}#v${existing.version + 1}` : baseKey;
    const { hits } = this.evaluate(norm);
    const hitIds = hits.toArray();
    const certificate = {
      epoch: this.epoch,
      query: norm,
      queryHash: qHash,
      hitIds,
      hitsHash: hashHitIds(hitIds),
      stateHash: this.epochStates.get(this.epoch),
    };
    certificate.hash = sha256hex(
      'cert:' + certificate.hitsHash + ':' + certificate.queryHash + ':' + certificate.epoch + ':' + certificate.stateHash
    );
    const entry = this._commit('recall', {
      recallId: key,
      certHash: certificate.hash,
      epoch: this.epoch,
      queryHash: qHash,
      hitsHash: certificate.hitsHash,
      hitCount: hitIds.length,
    });
    this.recalls.set(key, {
      baseKey,
      version: existing ? existing.version + 1 : 1,
      certificate,
      bitmap: hits,
      revoked: false,
      ledgerSeq: entry.seq,
      revokedAtSeq: null,
    });
    return { ...certificate, recallId: key, deduped: false };
  }

  // Revoke a recall mark. The epoch is restored to the recall's epoch (the
  // recall set is no longer asserted), but the ledger keeps the full causal
  // chain: the original recall entry is never rewritten or removed.
  revoke(query, opts = {}) {
    const norm = normalizeQuery(query);
    const qHash = queryNormHash(norm);
    const epoch = Number.isInteger(opts.epoch) ? opts.epoch : this._latestRecallEpoch(qHash);
    if (epoch === null) {
      throw new RecallError(E_PROOF, 'no recall exists for this query');
    }
    const found = this._latestRecord(qHash, epoch);
    if (!found) throw new RecallError(E_PROOF, `no recall for this query at epoch ${epoch}`);
    const rec = found.record;
    if (rec.revoked) throw new RecallError(E_DUP, `recall already revoked: ${found.recallId}`);
    rec.revoked = true;
    const entry = this._commit('revoke', {
      recallId: found.recallId,
      revokedCertHash: rec.certificate.hash,
      recallLedgerSeq: rec.ledgerSeq,
    });
    rec.revokedAtSeq = entry.seq;
    return {
      recallId: found.recallId,
      epoch,
      revokedCertHash: rec.certificate.hash,
      ledgerSeq: entry.seq,
    };
  }

  _latestRecord(qHash, epoch) {
    const baseKey = `${qHash}@${epoch}`;
    let best = null;
    for (const [recallId, record] of this.recalls) {
      if (record.baseKey !== baseKey) continue;
      if (!best || record.version > best.record.version) best = { recallId, record, version: record.version };
    }
    return best;
  }

  _latestRecallEpoch(qHash) {
    let best = null;
    for (const record of this.recalls.values()) {
      const [k, e] = record.baseKey.split('@');
      if (k !== qHash) continue;
      const epoch = Number(e);
      if (best === null || epoch > best) best = epoch;
    }
    return best;
  }

  // Verify a certificate. With { atEpoch } the certificate is checked against
  // the historical index state of that epoch (old proofs remain valid after
  // later deletions). Otherwise it must match the live state.
  prove(certificate, opts = {}) {
    const atEpoch = Number.isInteger(opts.atEpoch) ? opts.atEpoch : null;
    const norm = normalizeQuery(certificate.query || {});
    const queryHash = queryNormHash(norm);
    if (queryHash !== certificate.queryHash) {
      throw new RecallError(E_PROOF, 'query normalization hash mismatch');
    }
    const hitIds = [...certificate.hitIds].sort((a, b) => a - b);
    if (hashHitIds(hitIds) !== certificate.hitsHash) {
      throw new RecallError(E_PROOF, 'ordered hit-id hash mismatch');
    }
    const expectedState = this.epochStates.get(certificate.epoch);
    if (expectedState === undefined || expectedState !== certificate.stateHash) {
      throw new RecallError(E_EPOCH, `certificate epoch ${certificate.epoch} not in index history`);
    }
    const hash = sha256hex(
      'cert:' + certificate.hitsHash + ':' + certificate.queryHash + ':' + certificate.epoch + ':' + certificate.stateHash
    );
    if (hash !== certificate.hash) {
      throw new RecallError(E_PROOF, 'certificate hash mismatch');
    }
    if (atEpoch === null && certificate.epoch !== this.epoch) {
      throw new RecallError(
        E_EPOCH,
        `certificate epoch ${certificate.epoch} != current epoch ${this.epoch}; re-run recall or prove with --at-epoch`
      );
    }
    const found = this._latestRecord(certificate.queryHash, certificate.epoch);
    const rec = found ? found.record : null;
    return {
      ok: true,
      recallId: found ? found.recallId : `${certificate.queryHash}@${certificate.epoch}`,
      epoch: certificate.epoch,
      currentEpoch: this.epoch,
      revoked: rec ? rec.revoked : null,
      historical: atEpoch !== null || certificate.epoch !== this.epoch,
    };
  }

  // Causal chain: every event with hash links; revocations reference the exact
  // recall entry they undo, so history cannot be rewritten as "never happened".
  audit() {
    const entries = this.ledger.map((e) => ({ ...e }));
    let valid = true;
    let prev = '0'.repeat(64);
    for (const e of entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || sha256hex('entry:' + hashCanonical(rest)) !== hash) {
        valid = false;
        break;
      }
      prev = hash;
    }
    return {
      valid,
      epoch: this.epoch,
      length: entries.length,
      entries,
      recalls: [...this.recalls.entries()].map(([id, r]) => ({
        recallId: id,
        epoch: r.certificate.epoch,
        certHash: r.certificate.hash,
        hitCount: r.certificate.hitIds.length,
        revoked: r.revoked,
        ledgerSeq: r.ledgerSeq,
        revokedAtSeq: r.revokedAtSeq,
      })),
    };
  }

  serialize() {
    return {
      epoch: this.epoch,
      nextId: this.index.nextId,
      docs: [...this.index.docs.entries()],
      batches: [...this.index.batches.entries()].map(([b, ids]) => [b, [...ids]]),
      epochStates: [...this.epochStates.entries()],
      recalls: [...this.recalls.entries()].map(([id, r]) => [
        id,
        {
          baseKey: r.baseKey,
          version: r.version,
          certificate: r.certificate,
          bitmap: r.bitmap.serialize(),
          revoked: r.revoked,
          ledgerSeq: r.ledgerSeq,
          revokedAtSeq: r.revokedAtSeq,
        },
      ]),
      ledger: this.ledger,
    };
  }

  static deserialize(obj) {
    const store = new Store();
    store.epoch = obj.epoch;
    store.index.nextId = obj.nextId;
    store.index.docs = new Map(obj.docs);
    store.index.batches = new Map(obj.batches.map(([b, ids]) => [b, new Set(ids)]));
    store.epochStates = new Map(obj.epochStates);
    store.ledger = obj.ledger;
    store.recalls = new Map(
      obj.recalls.map(([id, r]) => [
        id,
        {
          baseKey: r.baseKey,
          version: r.version,
          certificate: r.certificate,
          bitmap: Bitmap.deserialize(r.bitmap),
          revoked: r.revoked,
          ledgerSeq: r.ledgerSeq,
          revokedAtSeq: r.revokedAtSeq,
        },
      ])
    );
    // Rebuild the inverted index from the surviving docs.
    store.index.postings = new Map();
    for (const [id, doc] of store.index.docs) {
      for (const { term, pos } of tokenize(doc.desc)) store._addPosting(term, FIELD_DESC, id, pos);
      store._addPosting(doc.code, FIELD_CODE, id, 0);
      store._addPosting(doc.batch, FIELD_BATCH, id, 0);
    }
    return store;
  }
}

module.exports = { Store, tokenize, normalizeQuery, queryNormHash, FIELD_DESC, FIELD_CODE, FIELD_BATCH, FIELD_NAMES };
