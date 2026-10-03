import fs from 'node:fs';
import path from 'node:path';
import { tokenize, PositionalIndex } from './indexer.js';

export const ERR_INVALID_EVENT = 'ERR_INVALID_EVENT';
export const ERR_DUPLICATE_ID = 'ERR_DUPLICATE_ID';
export const ERR_UNKNOWN_EVENT = 'ERR_UNKNOWN_EVENT';
export const ERR_UNKNOWN_TRADE = 'ERR_UNKNOWN_TRADE';
export const ERR_TRADE_ALREADY_UNDONE = 'ERR_TRADE_ALREADY_UNDONE';
export const ERR_BUDGET_EXCEEDED = 'ERR_BUDGET_EXCEEDED';

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
const REFUNDS = 'refunds.jsonl';

const pad = (n) => String(n).padStart(6, '0');

function readManifestSafe(file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest && Array.isArray(manifest.segments) && Array.isArray(manifest.tombstones)) {
      return manifest;
    }
  } catch {
    // missing or half-written manifest: caller falls back
  }
  return null;
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export class Store {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.mergeThreshold = options.mergeThreshold ?? 0.5;
    fs.mkdirSync(dir, { recursive: true });
    this._load();
    this._gc();
  }

  static open(dir, options) {
    return new Store(dir, options);
  }

  _load() {
    this.events = new Map();
    this.order = [];
    this.tombstoned = new Set();
    this.idToSeg = new Map();
    this.segStats = new Map();
    this.index = new PositionalIndex();
    this.refunds = new Map();

    let manifest = readManifestSafe(path.join(this.dir, MANIFEST))
      ?? readManifestSafe(path.join(this.dir, MANIFEST_BAK));
    if (!manifest) {
      const files = fs.readdirSync(this.dir).sort();
      manifest = {
        generation: 0,
        segments: files.filter((f) => /^seg-.*\.jsonl$/.test(f)),
        tombstones: files.filter((f) => /^tomb-.*\.jsonl$/.test(f)),
      };
    }
    this.manifest = manifest;

    for (const seg of manifest.segments) {
      const file = path.join(this.dir, seg);
      if (!fs.existsSync(file)) continue;
      let total = 0;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (this.events.has(event.id)) continue;
        this.events.set(event.id, event);
        this.order.push(event.id);
        this.idToSeg.set(event.id, seg);
        total++;
      }
      this.segStats.set(seg, { total, live: total });
    }

    for (const tomb of manifest.tombstones) {
      const file = path.join(this.dir, tomb);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const { id } = JSON.parse(line);
        if (this.events.has(id) && !this.tombstoned.has(id)) {
          this.tombstoned.add(id);
          this.segStats.get(this.idToSeg.get(id)).live--;
        }
      }
    }

    for (const id of this.order) {
      if (!this.tombstoned.has(id)) this.index.add(id, this.events.get(id).text ?? '');
    }

    const refundsFile = path.join(this.dir, REFUNDS);
    if (fs.existsSync(refundsFile)) {
      for (const line of fs.readFileSync(refundsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        this.refunds.set(record.tradeId, record);
      }
    }
  }

  _gc() {
    const keep = new Set([MANIFEST, MANIFEST_BAK, REFUNDS,
      ...this.manifest.segments, ...this.manifest.tombstones]);
    const bak = readManifestSafe(path.join(this.dir, MANIFEST_BAK));
    if (bak) {
      for (const f of [...bak.segments, ...bak.tombstones]) keep.add(f);
    }
    for (const file of fs.readdirSync(this.dir)) {
      if (!keep.has(file)) {
        try {
          fs.unlinkSync(path.join(this.dir, file));
        } catch {
          // best effort cleanup of uncommitted files
        }
      }
    }
  }

  _commit(manifest) {
    const current = path.join(this.dir, MANIFEST);
    if (fs.existsSync(current)) fs.copyFileSync(current, path.join(this.dir, MANIFEST_BAK));
    const tmp = path.join(this.dir, MANIFEST_TMP);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fsyncFile(tmp);
    fs.renameSync(tmp, current);
    fsyncDir(this.dir);
    this.manifest = manifest;
  }

  _ensureActiveSegment() {
    if (this.manifest.segments.length) return;
    const generation = this.manifest.generation + 1;
    const seg = `seg-${pad(generation)}.jsonl`;
    const tomb = `tomb-${pad(generation)}.jsonl`;
    fs.writeFileSync(path.join(this.dir, seg), '');
    fs.writeFileSync(path.join(this.dir, tomb), '');
    this._commit({ generation, segments: [seg], tombstones: [tomb] });
    this.segStats.set(seg, { total: 0, live: 0 });
  }

  append(event) {
    const { id, tradeId } = event ?? {};
    if (!id || !tradeId) {
      throw new StoreError(ERR_INVALID_EVENT, 'event requires id and tradeId');
    }
    if (this.events.has(id)) {
      throw new StoreError(ERR_DUPLICATE_ID, `duplicate event id: ${id}`);
    }
    this._ensureActiveSegment();
    const seg = this.manifest.segments[this.manifest.segments.length - 1];
    const record = {
      id,
      tradeId,
      fee: event.fee ?? 0,
      refundBudget: event.refundBudget ?? 0,
      text: event.text ?? '',
      state: event.state ?? 'open',
    };
    const file = path.join(this.dir, seg);
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    fsyncFile(file);
    this.events.set(id, record);
    this.order.push(id);
    this.idToSeg.set(id, seg);
    const stats = this.segStats.get(seg);
    stats.total++;
    stats.live++;
    this.index.add(id, record.text);
    return record;
  }

  delete(id) {
    if (!this.events.has(id) || this.tombstoned.has(id)) {
      throw new StoreError(ERR_UNKNOWN_EVENT, `unknown event: ${id}`);
    }
    this._ensureActiveSegment();
    const tomb = this.manifest.tombstones[this.manifest.tombstones.length - 1];
    const file = path.join(this.dir, tomb);
    fs.appendFileSync(file, JSON.stringify({ id }) + '\n');
    fsyncFile(file);
    this.tombstoned.add(id);
    this.index.remove(id);
    const stats = this.segStats.get(this.idToSeg.get(id));
    stats.live--;
    if (this.mergeThreshold > 0 && stats.total > 0
        && stats.live / stats.total < this.mergeThreshold) {
      this.merge();
    }
    return { id, deleted: true };
  }

  merge() {
    const generation = this.manifest.generation + 1;
    const seg = `seg-${pad(generation)}.jsonl`;
    const tomb = `tomb-${pad(generation)}.jsonl`;
    const tmpSeg = path.join(this.dir, `${seg}.tmp`);
    const lines = [];
    for (const id of this.order) {
      if (!this.tombstoned.has(id)) lines.push(JSON.stringify(this.events.get(id)));
    }
    fs.writeFileSync(tmpSeg, lines.length ? lines.join('\n') + '\n' : '');
    fsyncFile(tmpSeg);
    fs.renameSync(tmpSeg, path.join(this.dir, seg));
    const tombPath = path.join(this.dir, tomb);
    fs.writeFileSync(tombPath, '');
    fsyncFile(tombPath);
    // Old segments stay on disk until the new manifest is committed, so
    // concurrent readers and crash recovery always see a consistent view.
    this._commit({ generation, segments: [seg], tombstones: [tomb] });
    this._load();
    return { generation, segments: [seg], live: lines.length };
  }

  undoTrade(tradeId) {
    if (this.refunds.has(tradeId)) {
      throw new StoreError(ERR_TRADE_ALREADY_UNDONE, `trade already undone: ${tradeId}`);
    }
    const events = [];
    for (const id of this.order) {
      if (this.tombstoned.has(id)) continue;
      const event = this.events.get(id);
      if (event.tradeId === tradeId) events.push(event);
    }
    if (!events.length) {
      throw new StoreError(ERR_UNKNOWN_TRADE, `unknown trade: ${tradeId}`);
    }
    const total = events.reduce((sum, event) => sum + event.fee, 0);
    const budget = Math.max(...events.map((event) => event.refundBudget));
    if (total > budget) {
      // All-or-nothing: nothing is written, state is untouched.
      throw new StoreError(ERR_BUDGET_EXCEEDED,
        `refund ${total} exceeds budget ${budget} for trade ${tradeId}`);
    }
    const record = { tradeId, amount: total, budgetBefore: budget, budgetAfter: budget - total };
    const file = path.join(this.dir, REFUNDS);
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    fsyncFile(file);
    this.refunds.set(tradeId, record);
    return { tradeId, refunded: total, budgetRemaining: budget - total };
  }

  queryPhrase(phrase) {
    return this.index.phrase(tokenize(phrase));
  }

  queryNear(terms, window = 5) {
    const list = Array.isArray(terms) ? terms.flatMap((t) => tokenize(t)) : tokenize(terms);
    return this.index.near(list, window);
  }

  liveEvents() {
    return this.order
      .filter((id) => !this.tombstoned.has(id))
      .map((id) => this.events.get(id));
  }

  stats() {
    return {
      generation: this.manifest.generation,
      events: this.events.size,
      live: this.events.size - this.tombstoned.size,
      tombstoned: this.tombstoned.size,
      segments: [...this.segStats.entries()].map(([name, s]) => ({
        name,
        total: s.total,
        live: s.live,
        liveness: s.total ? s.live / s.total : 1,
      })),
      refunds: [...this.refunds.values()],
    };
  }
}
