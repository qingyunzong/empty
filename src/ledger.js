import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32 } from './crc32.js';
import { LedgerError, E_CRC, E_SAVEPOINT, E_VALID } from './errors.js';
import {
  applyRecord,
  createState,
  deserializeState,
  hashState,
  planOp,
  serializeState,
  subtreeTotals,
} from './decoder.js';

const MAGIC = 'MLC1';
const HEADER_SIZE = 12;
const LOG_FILE = 'events.log';
const MANIFEST_FILE = 'manifest.json';
const SNAPSHOT_DIR = 'snapshots';

export function encodeChunk(records) {
  const payload = Buffer.from(JSON.stringify({ records }), 'utf8');
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  header.writeUInt32LE(crc32(payload), 8);
  return Buffer.concat([header, payload]);
}

export function decodeChunks(buf, start = 0) {
  const chunks = [];
  let pos = start;
  const fail = (reason) => {
    throw new LedgerError(E_CRC, `corrupt chunk at offset ${pos}: ${reason}`, { offset: pos });
  };
  while (pos < buf.length) {
    if (pos + HEADER_SIZE > buf.length) fail('truncated header');
    if (buf.toString('ascii', pos, pos + 4) !== MAGIC) fail('bad magic');
    const length = buf.readUInt32LE(pos + 4);
    const crc = buf.readUInt32LE(pos + 8);
    if (pos + HEADER_SIZE + length > buf.length) fail('truncated payload');
    const payload = buf.subarray(pos + HEADER_SIZE, pos + HEADER_SIZE + length);
    if (crc32(payload) !== crc) fail('crc mismatch');
    let parsed;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      fail('invalid json payload');
    }
    if (!parsed || !Array.isArray(parsed.records)) fail('payload missing records');
    chunks.push({ offset: pos, end: pos + HEADER_SIZE + length, records: parsed.records });
    pos += HEADER_SIZE + length;
  }
  return chunks;
}

function emptyManifest() {
  return { version: 1, savepoints: {}, snapshots: [], rollbacks: [] };
}

function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export class Ledger {
  static open(dir) {
    const ledger = new Ledger(dir);
    ledger._load();
    return ledger;
  }

  static recover(dir) {
    const logPath = join(dir, LOG_FILE);
    if (!existsSync(logPath)) return { truncated: false, offset: 0 };
    const buf = readFileSync(logPath);
    let end = buf.length;
    let truncated = false;
    try {
      decodeChunks(buf, 0);
    } catch (err) {
      if (!(err instanceof LedgerError && err.code === E_CRC)) throw err;
      end = err.details.offset;
      truncateSync(logPath, end);
      truncated = true;
    }
    const manifestPath = join(dir, MANIFEST_FILE);
    if (truncated && existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.snapshots = (manifest.snapshots ?? []).filter(
        (snap) => snap.offset <= end && existsSync(join(dir, SNAPSHOT_DIR, snap.file)),
      );
      for (const [name, sp] of Object.entries(manifest.savepoints ?? {})) {
        if (sp.offset > end) delete manifest.savepoints[name];
      }
      writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
    }
    return { truncated, offset: end };
  }

  constructor(dir) {
    this.dir = dir;
    this.logPath = join(dir, LOG_FILE);
    this.manifestPath = join(dir, MANIFEST_FILE);
    this.snapshotDir = join(dir, SNAPSHOT_DIR);
  }

  _load() {
    mkdirSync(this.dir, { recursive: true });
    mkdirSync(this.snapshotDir, { recursive: true });
    this.manifest = existsSync(this.manifestPath)
      ? JSON.parse(readFileSync(this.manifestPath, 'utf8'))
      : emptyManifest();
    this.manifest.savepoints ??= {};
    this.manifest.snapshots ??= [];
    this.manifest.rollbacks ??= [];
    if (!existsSync(this.logPath)) writeFileSync(this.logPath, Buffer.alloc(0));
    const buf = readFileSync(this.logPath);

    let state = createState();
    let offset = 0;
    for (let i = this.manifest.snapshots.length - 1; i >= 0; i -= 1) {
      const snap = this.manifest.snapshots[i];
      if (snap.offset > buf.length) continue;
      const snapPath = join(this.snapshotDir, snap.file);
      if (!existsSync(snapPath)) continue;
      try {
        const data = JSON.parse(readFileSync(snapPath, 'utf8'));
        const candidate = deserializeState(data.state);
        if (data.seq !== candidate.seq || hashState(candidate) !== data.stateHash) continue;
        state = candidate;
        offset = snap.offset;
        break;
      } catch {
        continue;
      }
    }

    this.state = state;
    this.records = [];
    this.keyIndex = new Map();
    for (const chunk of decodeChunks(buf, offset)) {
      for (const record of chunk.records) this._applyLoaded(record);
    }
    this.offset = buf.length;
  }

  _applyLoaded(record) {
    applyRecord(this.state, record);
    this.records.push(record);
    if (record.key !== undefined && record.result !== undefined) {
      this.keyIndex.set(record.key, record.result);
    }
  }

  _appendRecords(records) {
    let seq = this.state.seq;
    for (const record of records) {
      if (record.seq === undefined) {
        seq += 1;
        record.seq = seq;
      } else {
        seq = record.seq;
      }
    }
    const chunk = encodeChunk(records);
    appendFileSync(this.logPath, chunk);
    for (const record of records) this._applyLoaded(record);
    this.offset += chunk.length;
  }

  _writeManifest() {
    writeFileAtomic(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  execute(op, params, key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new LedgerError(E_VALID, 'idempotency key must be a non-empty string');
    }
    const seen = this.keyIndex.get(key);
    if (seen !== undefined) return structuredClone(seen);
    let planned;
    try {
      planned = planOp(this.state, op, params);
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'E_STOCK') {
        planned = {
          register: null,
          effects: [],
          result: { ok: false, op, code: err.code, message: err.message },
        };
      } else {
        throw err;
      }
    }
    const record = {
      kind: 'cmd',
      key,
      op,
      params,
      status: planned.result.ok ? 'applied' : 'rejected',
      register: planned.register,
      effects: planned.effects,
      result: planned.result,
    };
    this._appendRecords([record]);
    return structuredClone(record.result);
  }

  savepoint(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new LedgerError(E_VALID, 'savepoint name must be a non-empty string');
    }
    const sp = {
      name,
      seq: this.state.seq,
      offset: this.offset,
      stateHash: hashState(this.state),
      createdAt: new Date().toISOString(),
    };
    this.manifest.savepoints[name] = sp;
    this._writeManifest();
    return structuredClone(sp);
  }

  rollback(name) {
    const sp = this.manifest.savepoints[name];
    if (!sp) throw new LedgerError(E_SAVEPOINT, `unknown savepoint: ${name}`);
    const targets = this.records
      .filter((r) => r.seq > sp.seq && Array.isArray(r.effects) && r.effects.length > 0)
      .reverse();
    const certId = `rb-${String(this.manifest.rollbacks.length + 1).padStart(4, '0')}`;
    const comps = targets.map((target) => ({
      kind: 'comp',
      key: `${certId}:${target.key ?? `seq${target.seq}`}`,
      op: 'compensate',
      compensates: target.key ?? null,
      compensatesSeq: target.seq,
      status: 'applied',
      register: null,
      effects: target.effects.map((e) => ({
        batch: e.batch,
        onHand: -(e.onHand ?? 0),
        reserved: -(e.reserved ?? 0),
      })),
      result: { ok: true, op: 'compensate', compensates: target.key ?? null, compensatesSeq: target.seq },
    }));
    let seq = this.state.seq;
    for (const comp of comps) {
      seq += 1;
      comp.seq = seq;
    }
    const certificate = {
      id: certId,
      savepoint: name,
      fromSeq: sp.seq,
      toSeq: this.state.seq,
      reversedKeys: targets.map((t) => t.key ?? `seq${t.seq}`),
      stateHashBefore: hashState(this.state),
      createdAt: new Date().toISOString(),
    };
    const rbRecord = {
      kind: 'rollback',
      key: certId,
      op: 'rollback',
      status: 'applied',
      register: null,
      effects: [],
      seq: seq + 1,
      certificate,
      result: { ok: true, op: 'rollback', certificate: certId },
    };
    const probe = deserializeState(serializeState(this.state));
    for (const record of [...comps, rbRecord]) applyRecord(probe, record);
    certificate.stateHashAfter = hashState(probe);
    this._appendRecords([...comps, rbRecord]);
    this.manifest.rollbacks.push({
      id: certId,
      savepoint: name,
      fromSeq: certificate.fromSeq,
      toSeq: certificate.toSeq,
      createdAt: certificate.createdAt,
    });
    this._writeManifest();
    return structuredClone(certificate);
  }

  snapshot() {
    const file = `snap-${String(this.state.seq).padStart(6, '0')}-${this.manifest.snapshots.length + 1}.json`;
    const data = {
      version: 1,
      seq: this.state.seq,
      offset: this.offset,
      stateHash: hashState(this.state),
      createdAt: new Date().toISOString(),
      state: serializeState(this.state),
    };
    writeFileAtomic(join(this.snapshotDir, file), JSON.stringify(data, null, 2));
    const entry = {
      file,
      seq: data.seq,
      offset: data.offset,
      stateHash: data.stateHash,
      createdAt: data.createdAt,
    };
    this.manifest.snapshots.push(entry);
    this._writeManifest();
    return structuredClone(entry);
  }

  status() {
    const batches = {};
    for (const name of [...this.state.batches.keys()].sort()) {
      const batch = this.state.batches.get(name);
      const totals = subtreeTotals(this.state, name);
      batches[name] = {
        parent: batch.parent,
        onHand: batch.onHand,
        reserved: batch.reserved,
        available: totals.available,
      };
    }
    return { seq: this.state.seq, batches };
  }

  history() {
    return structuredClone(this.records);
  }
}
