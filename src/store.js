// Segment-based order event store.
//
// Durability / commit protocol:
//   - Events, tombstones and refunds are appended as JSONL records to the
//     current segment file and fsynced before the call returns.
//   - Segment membership is committed via manifest.json. A merge writes the
//     new segment, then manifest.json.tmp, fsyncs, and renames it over
//     manifest.json (the commit point). manifest.json.bak always holds the
//     previous committed manifest.
//   - On open, a missing or half-written manifest.json falls back to
//     manifest.json.bak (old segments); if both are unusable, all segment
//     files in the directory are scanned. Old segments are deleted only
//     after the new manifest is fully committed, so a crash at any point
//     leaves a readable state.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TextIndex } from './textindex.js';

export const ERR_UNKNOWN_TRADE = 'UNKNOWN_TRADE';
export const ERR_INSUFFICIENT_BUDGET = 'INSUFFICIENT_BUDGET';
export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_DUPLICATE_ID = 'DUPLICATE_ID';
export const ERR_INVALID_EVENT = 'INVALID_EVENT';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const MANIFEST = 'manifest.json';
const MANIFEST_BAK = 'manifest.json.bak';
const MANIFEST_TMP = 'manifest.json.tmp';
const SEG_RE = /^seg-(\d+)\.jsonl$/;

function segName(seq) {
  return `seg-${String(seq).padStart(6, '0')}.jsonl`;
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort on some platforms.
  }
}

function appendRecord(dir, seg, rec) {
  const line = JSON.stringify(rec) + '\n';
  const fd = fs.openSync(path.join(dir, seg), 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class OrderStore {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.mergeThreshold = opts.mergeThreshold ?? 0.5;
    this.autoMerge = opts.autoMerge ?? false;

    this.segments = [];
    this.currentSeg = null;
    this._segSeq = 0;
    this.segStats = new Map(); // seg -> {records, dead}

    this.events = new Map();   // id -> event record
    this.eventSeg = new Map(); // id -> segment holding the event record
    this.deleted = new Set();  // tombstoned ids
    this.refunds = new Map();  // tradeId -> refunded amount
    this.index = new TextIndex();
    this._merging = null;
  }

  static async open(dir, opts = {}) {
    const store = new OrderStore(dir, opts);
    store._load();
    return store;
  }

  _stat(seg) {
    let s = this.segStats.get(seg);
    if (!s) {
      s = { records: 0, dead: 0 };
      this.segStats.set(seg, s);
    }
    return s;
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true });

    let segments = null;
    let manifestValid = false;
    for (const name of [MANIFEST, MANIFEST_BAK]) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
        if (manifest && Array.isArray(manifest.segments)) {
          segments = manifest.segments.filter((s) =>
            fs.existsSync(path.join(this.dir, s)),
          );
          manifestValid = name === MANIFEST;
          break;
        }
      } catch {
        // Missing or half-written manifest: fall back to the next source.
      }
    }
    if (segments === null) {
      segments = fs
        .readdirSync(this.dir)
        .filter((f) => SEG_RE.test(f))
        .sort();
    }

    for (const seg of segments) {
      if (!SEG_RE.test(seg)) continue;
      this._segSeq = Math.max(this._segSeq, Number(SEG_RE.exec(seg)[1]));
      this.segments.push(seg);
      this._stat(seg);
      const lines = fs
        .readFileSync(path.join(this.dir, seg), 'utf8')
        .split('\n')
        .filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          this._apply(JSON.parse(line), seg);
        } catch {
          // Tolerate a torn final line from a crashed append.
        }
      }
    }

    if (this.segments.length === 0) {
      this._segSeq = 1;
      const seg = segName(this._segSeq);
      fs.writeFileSync(path.join(this.dir, seg), '');
      this.segments.push(seg);
      this._stat(seg);
      this._writeManifestSync();
    } else if (!manifestValid) {
      // Self-heal: re-commit the recovered segment list as the manifest.
      this._writeManifestSync();
    }
    this.currentSeg = this.segments[this.segments.length - 1];
  }

  _apply(rec, seg) {
    const stat = this._stat(seg);
    stat.records++;
    switch (rec.type) {
      case 'event': {
        const ev = {
          id: rec.id,
          tradeId: rec.tradeId,
          fee: rec.fee,
          refundBudget: rec.refundBudget,
          text: rec.text,
          state: rec.state,
        };
        this.events.set(ev.id, ev);
        this.eventSeg.set(ev.id, seg);
        this.index.add(ev.id, ev.text ?? '');
        break;
      }
      case 'delete': {
        this.deleted.add(rec.id);
        this.index.remove(rec.id);
        stat.dead++; // the tombstone itself is compaction garbage
        const home = this.eventSeg.get(rec.id);
        if (home && this.segStats.has(home)) this._stat(home).dead++;
        break;
      }
      case 'refund': {
        this.refunds.set(rec.tradeId, (this.refunds.get(rec.tradeId) ?? 0) + rec.amount);
        for (const ev of this.events.values()) {
          if (ev.tradeId === rec.tradeId && !this.deleted.has(ev.id)) {
            ev.state = 'refunded';
          }
        }
        break;
      }
      default:
        break;
    }
  }

  _writeManifestSync() {
    const tmp = path.join(this.dir, MANIFEST_TMP);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify({ version: 1, segments: this.segments }) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(this.dir, MANIFEST));
    fs.copyFileSync(path.join(this.dir, MANIFEST), path.join(this.dir, MANIFEST_BAK));
    fsyncDir(this.dir);
  }

  _append(rec) {
    appendRecord(this.dir, this.currentSeg, rec);
    this._apply(rec, this.currentSeg);
  }

  // ---- public API ----

  addEvent(ev) {
    if (
      !ev ||
      typeof ev.id !== 'string' ||
      typeof ev.tradeId !== 'string' ||
      typeof ev.fee !== 'number' ||
      typeof ev.refundBudget !== 'number'
    ) {
      throw new StoreError(ERR_INVALID_EVENT, 'event needs id, tradeId, fee, refundBudget');
    }
    if (this.events.has(ev.id)) {
      throw new StoreError(ERR_DUPLICATE_ID, `duplicate event id ${ev.id}`);
    }
    const rec = {
      type: 'event',
      id: ev.id,
      tradeId: ev.tradeId,
      fee: ev.fee,
      refundBudget: ev.refundBudget,
      text: ev.text ?? '',
      state: ev.state ?? 'open',
    };
    this._append(rec);
    return this.events.get(ev.id);
  }

  async delete(id) {
    if (!this.events.has(id) || this.deleted.has(id)) {
      throw new StoreError(ERR_NOT_FOUND, `unknown event id ${id}`);
    }
    // Tombstone is written (and fsynced) before any in-memory change.
    this._append({ type: 'delete', id });
    if (this.autoMerge && this.liveness() < this.mergeThreshold) {
      await this.merge();
    }
  }

  // Refund every non-refunded fee of a trade in one shot, capped by the
  // trade's remaining refund budget. All-or-nothing: when the budget cannot
  // cover the full amount, nothing is refunded and no state changes.
  undoTrade(tradeId) {
    const live = [...this.events.values()].filter(
      (ev) => ev.tradeId === tradeId && !this.deleted.has(ev.id),
    );
    if (live.length === 0) {
      throw new StoreError(ERR_UNKNOWN_TRADE, `unknown tradeId ${tradeId}`);
    }
    const budget = Math.max(...live.map((ev) => ev.refundBudget));
    const refundedSoFar = this.refunds.get(tradeId) ?? 0;
    const remaining = budget - refundedSoFar;
    const due = live
      .filter((ev) => ev.state !== 'refunded')
      .reduce((sum, ev) => sum + ev.fee, 0);
    if (due === 0) {
      return { tradeId, refunded: 0, budget, budgetRemaining: remaining };
    }
    if (due > remaining) {
      throw new StoreError(
        ERR_INSUFFICIENT_BUDGET,
        `refund ${due} exceeds remaining budget ${remaining} for ${tradeId}`,
      );
    }
    // Single atomic record: either the refund is durable or nothing changed.
    this._append({ type: 'refund', tradeId, amount: due });
    return { tradeId, refunded: due, budget, budgetRemaining: remaining - due };
  }

  phraseQuery(phrase) {
    return this.index.phraseQuery(phrase);
  }

  nearQuery(terms, window) {
    return this.index.nearQuery(terms, window);
  }

  liveness() {
    let records = 0;
    let dead = 0;
    for (const s of this.segStats.values()) {
      records += s.records;
      dead += s.dead;
    }
    return records === 0 ? 1 : (records - dead) / records;
  }

  report() {
    const trades = {};
    for (const ev of this.events.values()) {
      if (this.deleted.has(ev.id)) continue;
      const t = (trades[ev.tradeId] ??= {
        feeTotal: 0,
        refundedTotal: 0,
        budget: 0,
        budgetRemaining: 0,
      });
      t.feeTotal += ev.fee;
      t.budget = Math.max(t.budget, ev.refundBudget);
    }
    for (const [tradeId, t] of Object.entries(trades)) {
      t.refundedTotal = this.refunds.get(tradeId) ?? 0;
      t.budgetRemaining = t.budget - t.refundedTotal;
    }
    return { trades };
  }

  // Merge all segments into one compacted segment containing only live
  // events and refund records. Queries during the merge keep reading the
  // in-memory index over the old segment set; the commit (manifest rename)
  // is the single cut-over point, and the live set never changes, so old
  // and new segments answer identically.
  async merge() {
    if (this._merging) return this._merging;
    this._merging = this._doMerge().finally(() => {
      this._merging = null;
    });
    return this._merging;
  }

  async _doMerge() {
    const newSeg = segName(++this._segSeq);
    const newPath = path.join(this.dir, newSeg);
    const lines = [];
    for (const ev of this.events.values()) {
      if (this.deleted.has(ev.id)) continue;
      lines.push(JSON.stringify({ type: 'event', ...ev }));
    }
    for (const [tradeId, amount] of this.refunds) {
      if (amount > 0) lines.push(JSON.stringify({ type: 'refund', tradeId, amount }));
    }
    const fd = await fsp.open(newPath, 'w');
    try {
      await fd.writeFile(lines.length ? lines.join('\n') + '\n' : '');
      await fd.sync();
    } finally {
      await fd.close();
    }

    // Commit: previous manifest -> .bak, new manifest via tmp + rename.
    const manifestPath = path.join(this.dir, MANIFEST);
    if (fs.existsSync(manifestPath)) {
      await fsp.copyFile(manifestPath, path.join(this.dir, MANIFEST_BAK));
    }
    const tmpPath = path.join(this.dir, MANIFEST_TMP);
    const mfd = await fsp.open(tmpPath, 'w');
    try {
      await mfd.writeFile(JSON.stringify({ version: 1, segments: [newSeg] }) + '\n');
      await mfd.sync();
    } finally {
      await mfd.close();
    }
    await fsp.rename(tmpPath, manifestPath); // commit point
    await fsp.copyFile(manifestPath, path.join(this.dir, MANIFEST_BAK));
    fsyncDir(this.dir);

    // Old segments are removed only after the commit is durable.
    for (const seg of this.segments) {
      await fsp.rm(path.join(this.dir, seg), { force: true });
    }

    this.segments = [newSeg];
    this.currentSeg = newSeg;
    this.segStats = new Map([[newSeg, { records: lines.length, dead: 0 }]]);
    for (const id of this.deleted) {
      this.events.delete(id);
      this.eventSeg.delete(id);
    }
    this.eventSeg = new Map([...this.events.keys()].map((id) => [id, newSeg]));
    this.deleted.clear();
    this.index.compact();
    return { segment: newSeg, liveRecords: lines.length };
  }

  async close() {
    if (this._merging) await this._merging;
  }
}
