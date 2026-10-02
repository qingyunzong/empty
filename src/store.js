import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ERR_NO_TARGET = 'NO_TARGET';
export const ERR_CYCLE = 'CYCLE';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const WAL_FILE = 'wal.log';
export const TARGET_INDEX_FILE = 'idx-target.json';
export const TIME_INDEX_FILE = 'idx-time.json';

function checksum(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function encodeRecord(rec) {
  const body = {
    seq: rec.seq,
    id: rec.id,
    target: rec.target,
    value: rec.value,
    corrects: rec.corrects,
    t: rec.t,
  };
  return JSON.stringify({ ...body, ck: checksum(JSON.stringify(body)) });
}

function decodeRecord(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { ck, ...body } = parsed;
  if (typeof ck !== 'string' || checksum(JSON.stringify(body)) !== ck) return null;
  return body;
}

// Replay the WAL into an id -> record map. Stops at the first torn/corrupt
// line, which can only be the uncommitted tail of a crashed write.
function replay(walPath) {
  const records = new Map();
  if (!fs.existsSync(walPath)) return records;
  const raw = fs.readFileSync(walPath, 'utf8');
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const rec = decodeRecord(line);
    if (rec === null) break;
    records.set(rec.id, rec);
  }
  return records;
}

function buildTargetIndex(records) {
  const idx = new Map();
  for (const rec of records.values()) {
    const cur = idx.get(rec.target);
    if (cur === undefined || rec.seq > cur.seq) idx.set(rec.target, { id: rec.id, seq: rec.seq });
  }
  return idx;
}

function buildTimeIndex(records) {
  return [...records.values()]
    .map((r) => ({ t: r.t, id: r.id, seq: r.seq }))
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class Store {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.flushEvery = options.flushEvery ?? 50;
    this.walPath = path.join(dir, WAL_FILE);
    this.records = replay(this.walPath);
    this.lastSeq = 0;
    for (const rec of this.records.values()) {
      if (rec.seq > this.lastSeq) this.lastSeq = rec.seq;
    }
    this.targetIndex = buildTargetIndex(this.records);
    this.timeIndex = buildTimeIndex(this.records);
    this.dirty = 0;
    this.fd = null;
  }

  // Commit one correction transaction: WAL append + fsync first, then the
  // in-memory state and secondary indexes are updated.
  commit({ id, target, value, corrects = null, t } = {}) {
    if (corrects === undefined) corrects = null;
    if (corrects !== null && !this.records.has(corrects)) {
      throw new StoreError(ERR_NO_TARGET, `cannot correct unknown record "${corrects}"`);
    }
    const seq = this.lastSeq + 1;
    const newId = id ?? `rec-${seq}`;
    // Cycle detection: walk the correction chain upwards from the record
    // being corrected; meeting the new id would close a reference loop.
    let cursor = corrects;
    while (cursor !== null) {
      if (cursor === newId) {
        throw new StoreError(ERR_CYCLE, `correction would create a cycle involving "${newId}"`);
      }
      cursor = this.records.get(cursor)?.corrects ?? null;
    }
    if (this.records.has(newId)) {
      throw new StoreError(ERR_CYCLE, `record id "${newId}" already exists`);
    }
    const parent = corrects === null ? null : this.records.get(corrects);
    const resolvedTarget = parent === null ? target : parent.target;
    if (resolvedTarget === undefined || resolvedTarget === null) {
      throw new StoreError('USAGE', 'target is required for an original observation');
    }
    if (value === undefined) {
      throw new StoreError('USAGE', 'value is required');
    }
    const rec = {
      seq,
      id: newId,
      target: resolvedTarget,
      value,
      corrects,
      t: t ?? Date.now(),
    };
    const line = `${encodeRecord(rec)}\n`;
    if (this.fd === null) this.fd = fs.openSync(this.walPath, 'a');
    fs.writeSync(this.fd, line);
    fs.fsyncSync(this.fd);
    this.#apply(rec);
    this.dirty += 1;
    if (this.dirty >= this.flushEvery) this.flush();
    return rec;
  }

  #apply(rec) {
    this.records.set(rec.id, rec);
    this.lastSeq = rec.seq;
    const cur = this.targetIndex.get(rec.target);
    if (!cur || rec.seq > cur.seq) this.targetIndex.set(rec.target, { id: rec.id, seq: rec.seq });
    this.timeIndex.push({ t: rec.t, id: rec.id, seq: rec.seq });
    this.timeIndex.sort((a, b) => a.t - b.t || a.seq - b.seq);
  }

  // Latest effective record for a target: the tail of its correction chain.
  resolve(target) {
    return this.#tail(this.#byTarget(target));
  }

  // The "view at time t": same as resolve but ignoring every correction
  // committed after t.
  viewAt(target, t) {
    return this.#tail(this.#byTarget(target).filter((r) => r.t <= t));
  }

  // The correction chain for a target, from the original observation to the
  // current tail. When a record was corrected more than once, the latest
  // correction wins.
  chain(target) {
    const candidates = this.#byTarget(target).sort((a, b) => a.seq - b.seq);
    const root = candidates.find((r) => r.corrects === null);
    if (!root) return [];
    const successor = new Map();
    for (const r of candidates) {
      if (r.corrects === null) continue;
      const cur = successor.get(r.corrects);
      if (!cur || r.seq > cur.seq) successor.set(r.corrects, r);
    }
    const out = [];
    let cur = root;
    while (cur) {
      out.push(cur);
      cur = successor.get(cur.id) ?? null;
    }
    return out;
  }

  // Records committed within [tFrom, tTo], served from the time index.
  range(tFrom, tTo) {
    return this.timeIndex
      .filter((e) => e.t >= tFrom && e.t <= tTo)
      .map((e) => this.records.get(e.id));
  }

  #byTarget(target) {
    return [...this.records.values()].filter((r) => r.target === target);
  }

  #tail(candidates) {
    if (candidates.length === 0) return null;
    const corrected = new Set();
    for (const r of candidates) {
      if (r.corrects !== null) corrected.add(r.corrects);
    }
    let best = null;
    for (const r of candidates) {
      if (!corrected.has(r.id) && (best === null || r.seq > best.seq)) best = r;
    }
    return best;
  }

  // Persist both secondary indexes atomically (tmp file + rename).
  flush() {
    writeAtomic(
      path.join(this.dir, TARGET_INDEX_FILE),
      JSON.stringify(Object.fromEntries(this.targetIndex), null, 2),
    );
    writeAtomic(path.join(this.dir, TIME_INDEX_FILE), JSON.stringify(this.timeIndex, null, 2));
    this.dirty = 0;
  }

  // Recompute both indexes from the WAL alone and compare them with the
  // on-disk index files. Missing, corrupt or stale files are rebuilt.
  verify() {
    const fresh = replay(this.walPath);
    const targetIdx = Object.fromEntries(buildTargetIndex(fresh));
    const timeIdx = buildTimeIndex(fresh);
    const targetOk =
      canonical(readJsonSafe(path.join(this.dir, TARGET_INDEX_FILE))) === canonical(targetIdx);
    const timeOk =
      canonical(readJsonSafe(path.join(this.dir, TIME_INDEX_FILE))) === canonical(timeIdx);
    if (targetOk && timeOk) return { ok: true, rebuilt: false };
    writeAtomic(path.join(this.dir, TARGET_INDEX_FILE), JSON.stringify(targetIdx, null, 2));
    writeAtomic(path.join(this.dir, TIME_INDEX_FILE), JSON.stringify(timeIdx, null, 2));
    return { ok: true, rebuilt: true };
  }

  close() {
    if (this.dirty > 0) this.flush();
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export function openStore(dir, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return new Store(dir, options);
}
