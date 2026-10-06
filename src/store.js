import { IllegalRollbackError, StoreError } from './errors.js';
import { sampleSetHash } from './samples.js';

export const STORE_FORMAT = 'qcert-store/1';

// Versioned sample store. Committed versions are immutable and never
// deleted; corrections become new versions. A draft is the only thing
// rollback may discard -- rolling back with no open draft is illegal.
export class SampleStore {
  constructor(data = null) {
    this.data = data ?? { format: STORE_FORMAT, versions: [], draft: null };
    if (this.data.format !== STORE_FORMAT) throw new StoreError(`unsupported store format '${this.data.format}'`);
  }

  static empty() { return new SampleStore(); }

  get versions() { return this.data.versions; }
  get draft() { return this.data.draft; }

  latest() {
    return this.data.versions.length === 0 ? null : this.data.versions[this.data.versions.length - 1];
  }

  // Idempotent: re-committing identical contents reuses the version.
  commit(parsedSamples, now = new Date().toISOString()) {
    const hash = sampleSetHash(parsedSamples);
    const latest = this.latest();
    if (latest && latest.hash === hash) return { version: latest, created: false };
    const version = {
      version: this.data.versions.length + 1,
      hash,
      committed_at: now,
      batch: parsedSamples.batch,
      samples: parsedSamples.samples,
    };
    this.data.versions.push(version);
    return { version, created: true };
  }

  beginDraft(parsedSamples, now = new Date().toISOString()) {
    if (this.data.draft) throw new StoreError('a draft is already open; commit or roll it back first');
    const latest = this.latest();
    this.data.draft = {
      based_on: latest ? latest.version : 0,
      hash: sampleSetHash(parsedSamples),
      staged_at: now,
      batch: parsedSamples.batch,
      samples: parsedSamples.samples,
    };
    return this.data.draft;
  }

  commitDraft(now = new Date().toISOString()) {
    if (!this.data.draft) throw new IllegalRollbackError('no uncommitted draft to commit');
    const draft = this.data.draft;
    this.data.draft = null;
    return this.commit({ batch: draft.batch, samples: draft.samples }, now);
  }

  // Rollback is only legal back to an uncommitted draft. Published
  // (committed) versions and their certificates stay traceable forever.
  rollback() {
    if (!this.data.draft) {
      throw new IllegalRollbackError('illegal rollback: no uncommitted draft exists; committed versions are immutable');
    }
    const discarded = this.data.draft;
    this.data.draft = null;
    return discarded;
  }
}

export const JOURNAL_FORMAT = 'qcert-journal/1';

// Append-only certificate journal. Superseded certificates are marked,
// never removed, so every published decision remains auditable.
export class Journal {
  constructor(records = []) {
    this.records = records;
  }

  static parse(text, sourceName = 'journal') {
    const records = [];
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const raw = lines[idx].trim();
      if (raw === '') continue;
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (err) {
        throw new StoreError(`invalid JSON in journal: ${err.message}`, { line: idx + 1, source: sourceName });
      }
      if (obj.format !== JOURNAL_FORMAT) {
        throw new StoreError(`unsupported journal record format '${obj.format}'`, { line: idx + 1, source: sourceName });
      }
      records.push(obj);
    }
    return new Journal(records);
  }

  serialize() {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + (this.records.length ? '\n' : '');
  }

  // Cert hashes currently ACTIVE for a given rule hash.
  activeCerts(ruleHash) {
    const superseded = new Set();
    for (const r of this.records) for (const h of r.supersedes) superseded.add(h);
    return this.records.filter((r) => r.rule_hash === ruleHash && !superseded.has(r.cert));
  }

  // Appends a decision record; previously active certs for the same rule
  // become SUPERSEDED (their records stay in the journal).
  append({ certHash, ruleHash, sampleVersion, sampleHash, decision, now = new Date().toISOString() }) {
    const supersedes = this.activeCerts(ruleHash).map((r) => r.cert);
    const record = {
      format: JOURNAL_FORMAT,
      cert: certHash,
      rule_hash: ruleHash,
      sample_version: sampleVersion,
      sample_hash: sampleHash,
      decision,
      supersedes,
      ts: now,
    };
    this.records.push(record);
    return record;
  }

  // 'ACTIVE' | 'SUPERSEDED' | 'UNKNOWN'
  statusOf(certHash) {
    const superseded = new Set();
    for (const r of this.records) for (const h of r.supersedes) superseded.add(h);
    if (superseded.has(certHash)) return 'SUPERSEDED';
    if (this.records.some((r) => r.cert === certHash)) return 'ACTIVE';
    return 'UNKNOWN';
  }
}
