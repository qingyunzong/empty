import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventLog } from './eventlog.js';
import { State, keyId, parseKeyId, compareEvents } from './state.js';
import { recover, writeFileAtomic } from './recover.js';
import { summarize } from './summarize.js';
import { normQuality } from './quality.js';
import { eventHash, sha256hex } from './hash.js';
import { toMs, toIso } from './time.js';

export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at fault point: ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

// Commit order (this ordering is what makes recovery decidable):
//   1. append event line(s) to events.log, fsync        [fault: beforeFsync]
//   2. apply to in-memory state, write index.json       [fault: afterIndex]
//   3. write manifest.json (the commit certificate)     [fault: afterManifest]
export class Archive {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.logPath = join(dir, 'events.log');
    this.indexPath = join(dir, 'index.json');
    this.manifestPath = join(dir, 'manifest.json');
    this._fault = opts.fault ?? null;
    this.crashed = false;
  }

  // Open always recovers first: recovery is idempotent, so a clean open is
  // a cheap verify and a crashed store is rolled forward transparently.
  static async open(dir, opts = {}) {
    await mkdir(dir, { recursive: true });
    const recovery = await recover(dir);
    const archive = new Archive(dir, opts);
    await archive._load();
    archive.recovery = recovery;
    return archive;
  }

  async _load() {
    const verified = await EventLog.readVerified(this.logPath);
    this.head = verified.headHash;
    this.logBytes = verified.validBytes;
    const index = JSON.parse(await readFile(this.indexPath, 'utf8'));
    this.state = State.fromJSON(index);
    const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
    this._indexHash = manifest.indexHash;
  }

  async _commit(drafts) {
    if (this.crashed) throw new Error('archive instance is dead after a simulated crash; reopen it');
    let seq = this.state.seq;
    let lamport = this.state.lamport;
    let prev = this.head;
    const records = drafts.map((draft) => {
      seq += 1;
      if (draft.lamport != null) {
        // explicit Lamport value: simulates a merged concurrent history
        lamport = Math.max(lamport, draft.lamport);
      } else {
        lamport += 1;
        draft = { ...draft, lamport };
      }
      const rec = { ...draft, seq, prev };
      rec.hash = eventHash(prev, rec);
      prev = rec.hash;
      return rec;
    });

    const data = records.map((r) => `${JSON.stringify(r)}\n`).join('');
    const prevBytes = this.logBytes;
    const fault = this._fault;
    this._fault = null;

    // --- step 1: append + fsync --------------------------------------
    await this._log().append(data, { sync: fault?.point !== 'beforeFsync' });
    if (fault?.point === 'beforeFsync') {
      // machine crash before fsync: the un-fsynced tail is lost
      await this._log().truncate(prevBytes);
      this.crashed = true;
      throw new CrashError('beforeFsync');
    }
    this.logBytes += Buffer.byteLength(data);
    this.head = records.at(-1).hash;

    // --- step 2: materialize index ------------------------------------
    for (const rec of records) this.state.applyEvent(rec);
    const indexBytes = Buffer.from(JSON.stringify(this.state.toJSON()));
    await writeFileAtomic(this.indexPath, indexBytes);
    this._indexHash = sha256hex(indexBytes);
    if (fault?.point === 'afterIndex') {
      this.crashed = true;
      throw new CrashError('afterIndex');
    }

    // --- step 3: manifest (commit certificate) ------------------------
    await this._writeManifest();
    if (fault?.point === 'afterManifest') {
      this.crashed = true;
      throw new CrashError('afterManifest');
    }
    return records;
  }

  _log() {
    return new EventLog(this.logPath);
  }

  async _writeManifest() {
    const manifest = {
      seq: this.state.seq,
      lamport: this.state.lamport,
      logBytes: this.logBytes,
      logHash: this.head,
      indexHash: this._indexHash,
    };
    await writeFileAtomic(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  _newBatchId(prefix) {
    let n = this.state.seq + 1;
    while (this.state.batches.has(`${prefix}-${n}`)) n += 1;
    return `${prefix}-${n}`;
  }

  _checkBatchId(batchId) {
    if (this.state.batches.has(batchId)) {
      throw new Error(`duplicate batchId: ${batchId}`);
    }
  }

  async ingest(records, { batchId } = {}) {
    if (!Array.isArray(records) || records.length === 0) throw new Error('ingest: no records');
    const bid = batchId ?? this._newBatchId('ingest');
    this._checkBatchId(bid);
    const drafts = records.map((r) => {
      if (typeof r.site !== 'string' || !r.site) throw new Error('ingest: record missing site');
      if (r.value !== null && r.value !== undefined && typeof r.value !== 'number') {
        throw new Error(`ingest: value must be a number or null, got ${JSON.stringify(r.value)}`);
      }
      return {
        type: 'ingest',
        site: r.site,
        time: toMs(r.time),
        value: r.value ?? null,
        quality: normQuality(r.quality),
        batchId: bid,
      };
    });
    await this._commit(drafts);
    return { batchId: bid, count: drafts.length, seq: this.state.seq };
  }

  async correct(batch) {
    if (!batch || !Array.isArray(batch.corrections) || batch.corrections.length === 0) {
      throw new Error('correct: batch.corrections must be a non-empty array');
    }
    const bid = batch.batchId ?? this._newBatchId('corr');
    this._checkBatchId(bid);
    const drafts = batch.corrections.map((c) => {
      if (typeof c.site !== 'string' || !c.site) throw new Error('correct: correction missing site');
      const base = { type: 'correct', site: c.site, time: toMs(c.time), batchId: bid };
      if (c.lamport != null) base.lamport = c.lamport;
      switch (c.op) {
        case 'replace':
          if (c.value !== null && c.value !== undefined && typeof c.value !== 'number') {
            throw new Error(`correct: replace value must be a number or null`);
          }
          return { ...base, op: 'replace', value: c.value ?? null, quality: normQuality(c.quality) };
        case 'flag':
          if (c.quality == null) throw new Error('correct: flag requires an explicit quality');
          return { ...base, op: 'flag', quality: normQuality(c.quality) };
        case 'delete':
          return { ...base, op: 'delete' };
        default:
          throw new Error(`correct: unknown op ${JSON.stringify(c.op)} (replace|flag|delete)`);
      }
    });
    await this._commit(drafts);
    return { batchId: bid, count: drafts.length, seq: this.state.seq };
  }

  // Undo is itself an appended event: the target batch stays in the log but
  // stops being visible. Only that batch's keys are re-folded; every other
  // batch's corrections keep applying, ordered by (lamport, site, seq).
  async undo(batchId) {
    const target = this.state.batches.get(batchId);
    if (!target) throw new Error(`undo: unknown batch: ${batchId}`);
    if (target.undone) throw new Error(`undo: batch already undone: ${batchId}`);
    await this._commit([{ type: 'undo', undoOf: batchId }]);
    const affectedKeys = [...target.keys].map((id) => {
      const { site, time } = parseKeyId(id);
      return `${site}@${toIso(time)}`;
    });
    return { undone: batchId, affectedKeys, seq: this.state.seq };
  }

  query(site, from, to) {
    const fromMs = toMs(from);
    const toMsV = toMs(to);
    if (fromMs > toMsV) throw new Error('query: from must be <= to');
    const agg = this.state.aggs.get(site);
    const counts = agg
      ? agg.query(fromMs, toMsV)
      : { weightSum: 0, weightedValueSum: 0, usedCount: 0, nullCount: 0, deletedCount: 0, badCount: 0, unknownCount: 0 };
    return { site, from: toIso(fromMs), to: toIso(toMsV), ...summarize(counts) };
  }

  // Full version chain for one key: every candidate with its hash, which
  // batch it came from, whether that batch was undone, and — for each
  // undone batch — the rollback boundary (what got masked, what was
  // restored). Tied to the current certificate head for verification.
  audit(key) {
    const at = key.lastIndexOf('@');
    if (at <= 0) throw new Error(`audit: key must be "site@time", got ${JSON.stringify(key)}`);
    const site = key.slice(0, at);
    const time = toMs(key.slice(at + 1));
    const id = keyId(site, time);
    const entry = this.state.keys.get(id);
    const candidates = entry ? [...entry.candidates].sort(compareEvents) : [];
    const history = candidates.map((c) => ({
      seq: c.seq,
      lamport: c.lamport,
      batchId: c.batchId,
      type: c.type,
      op: c.type === 'ingest' ? 'replace' : c.op,
      value: c.value ?? null,
      quality: c.quality ?? null,
      undone: this.state.undone.has(c.batchId),
      hash: c.hash,
    }));
    const current = this.state.current.get(id) ?? null;
    const rollbackBoundaries = [];
    for (const bid of new Set(candidates.map((c) => c.batchId))) {
      if (this.state.undone.has(bid)) {
        rollbackBoundaries.push({
          batchId: bid,
          maskedSeqs: candidates.filter((c) => c.batchId === bid).map((c) => c.seq),
          maskedHashes: candidates.filter((c) => c.batchId === bid).map((c) => c.hash),
          restoredVersion: current,
        });
      }
    }
    return {
      key: `${site}@${toIso(time)}`,
      site,
      time: toIso(time),
      current,
      history,
      rollbackBoundaries,
      certificate: { head: this.head, seq: this.state.seq },
    };
  }

  // Recompute the hash chain from the log and check every artifact against
  // the manifest. This is the certificate check required after recovery.
  async verify() {
    const verified = await EventLog.readVerified(this.logPath);
    const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
    const indexBytes = await readFile(this.indexPath);
    const checks = {
      chainIntact: !verified.torn,
      seqContinuous: verified.headSeq === this.state.seq,
      manifestSeq: manifest.seq === verified.headSeq,
      manifestLogHash: manifest.logHash === verified.headHash,
      manifestLogBytes: manifest.logBytes === verified.validBytes,
      indexHash: sha256hex(indexBytes) === manifest.indexHash,
    };
    return {
      ok: Object.values(checks).every(Boolean),
      checks,
      seq: verified.headSeq,
      head: verified.headHash,
    };
  }
}
