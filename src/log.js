import fs from 'node:fs';
import path from 'node:path';
import {
  GENESIS_HASH,
  DEFAULT_PAGE_SIZE,
  maxPayloadSize,
  encodePage,
  validatePage,
  sha256,
} from './page.js';
import { Scheduler } from './scheduler.js';

export const DATA_FILE = 'data.log';
export const QUARANTINE_DIR = 'quarantine';
export const READONLY_MARKER = 'READONLY';

export class AuditError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function recordBytes(record) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8') + 1; // + '\n'
}

export function dataFileOf(dir) {
  return path.join(dir, DATA_FILE);
}

// Sequentially scan the log file, validating every page against the hash chain.
// Deterministic: stops at the first inconsistent page; anything beyond is orphan data.
export function scanFile(filePath, pageSize = DEFAULT_PAGE_SIZE) {
  const pages = [];
  let prevHash = GENESIS_HASH;
  let offset = 0;
  let firstBad = null;
  let size = 0;
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    size = buf.length;
    while (offset + pageSize <= size) {
      const res = validatePage(buf.subarray(offset, offset + pageSize), pages.length, prevHash);
      if (!res.ok) {
        firstBad = { offset, pageIndex: pages.length, reason: res.reason };
        break;
      }
      pages.push({ index: res.pageIndex, records: res.records, pageHash: res.pageHash, offset });
      prevHash = res.pageHash;
      offset += pageSize;
    }
  }
  const trailingBytes = size - offset;
  if (!firstBad && trailingBytes > 0) {
    firstBad = { offset, pageIndex: pages.length, reason: 'TRAILING_BYTES' };
  }
  return { pages, firstBad, trailingBytes, lastHash: prevHash };
}

function tenantStateFrom(pages) {
  const tenants = new Map();
  for (const page of pages) {
    for (const record of page.records) {
      const t = tenants.get(record.tenant) ?? { lastSeq: -1, bytes: 0, count: 0 };
      t.lastSeq = record.seq;
      t.bytes += recordBytes(record);
      t.count += 1;
      tenants.set(record.tenant, t);
    }
  }
  return tenants;
}

// Recover a log directory to its most recent consistent prefix.
// Orphan bytes (uncommitted/torn/corrupt tail) are moved to quarantine with a
// deterministic proof, then the file is truncated. Recovery is idempotent.
export function recoverLog(dir, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const file = dataFileOf(dir);
  const { pages, firstBad, trailingBytes, lastHash } = scanFile(file, pageSize);
  const quarantine = [];
  if (trailingBytes > 0) {
    const offset = pages.length * pageSize;
    const orphan = fs.readFileSync(file).subarray(offset);
    const qdir = path.join(dir, QUARANTINE_DIR);
    fs.mkdirSync(qdir, { recursive: true });
    const name = `orphan-${offset}`;
    fs.writeFileSync(path.join(qdir, `${name}.bin`), orphan);
    const proof = {
      offset,
      length: orphan.length,
      sha256: sha256(orphan).toString('hex'),
      reason: firstBad.reason,
      lastCommittedPage: pages.length - 1,
      lastCommittedHash: lastHash.toString('hex'),
    };
    fs.writeFileSync(path.join(qdir, `${name}.proof.json`), JSON.stringify(proof, null, 2));
    fs.truncateSync(file, offset);
    quarantine.push(proof);
  }
  const records = pages.reduce((n, p) => n + p.records.length, 0);
  return {
    committedPages: pages.length,
    records,
    truncatedBytes: trailingBytes,
    quarantine,
    root: lastHash.toString('hex'),
  };
}

// Read-only verification: validates the hash chain and per-tenant sequences,
// never mutates the log. Returns violations instead of throwing.
export function verifyLog(dir, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const file = dataFileOf(dir);
  const { pages, firstBad, trailingBytes, lastHash } = scanFile(file, pageSize);
  const violations = [];
  if (firstBad) {
    violations.push({ code: 'CORRUPT', offset: firstBad.offset, pageIndex: firstBad.pageIndex, reason: firstBad.reason });
  }
  const lastSeq = new Map();
  const tenants = {};
  let records = 0;
  for (const page of pages) {
    for (const record of page.records) {
      records += 1;
      const expected = (lastSeq.get(record.tenant) ?? -1) + 1;
      if (record.seq !== expected) {
        violations.push({ code: 'SEQ_GAP', tenant: record.tenant, expected, got: record.seq });
      }
      lastSeq.set(record.tenant, record.seq);
      const t = tenants[record.tenant] ?? { count: 0, bytes: 0 };
      t.count += 1;
      t.bytes += recordBytes(record);
      tenants[record.tenant] = t;
    }
  }
  return {
    ok: violations.length === 0,
    stats: { pages: pages.length, records, tenants, trailingBytes },
    root: lastHash.toString('hex'),
    violations,
  };
}

export class AppendLog {
  static open(dir, opts = {}) {
    return new AppendLog(dir, opts);
  }

  constructor(dir, {
    pageSize = DEFAULT_PAGE_SIZE,
    bufferPages = 4,
    quotas = {},
    agingFactor = 1,
    readonly = false,
    onBeforeFsync = null,
  } = {}) {
    this.dir = dir;
    this.pageSize = pageSize;
    this.bufferPages = bufferPages;
    this.quotas = quotas;
    this.readonly = readonly || fs.existsSync(path.join(dir, READONLY_MARKER));
    this.onBeforeFsync = onBeforeFsync;
    this.crashed = false;
    this.bufferedBytes = 0;

    if (!fs.existsSync(dir)) {
      if (this.readonly) throw new AuditError('READONLY', `log dir does not exist: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.file = dataFileOf(dir);
    const { pages, trailingBytes, lastHash } = scanFile(this.file, pageSize);
    if (trailingBytes > 0) {
      throw new AuditError('CORRUPT', 'log has uncommitted/corrupt tail; run recover first', { trailingBytes });
    }
    this.committedPages = pages.length;
    this.lastHash = lastHash;
    this.tenants = tenantStateFrom(pages); // committed state
    this.bufferedSeq = new Map(); // tenant -> last buffered seq
    this.bufferedTenantBytes = new Map();

    this.scheduler = new Scheduler({ quotas, agingFactor });
    if (this.readonly) {
      this.fd = fs.existsSync(this.file) ? fs.openSync(this.file, 'r') : null;
    } else {
      if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '');
      this.fd = fs.openSync(this.file, 'r+'); // positioned writes; O_APPEND would ignore offsets
    }
  }

  _quota(tenant) {
    return this.quotas[tenant] ?? {};
  }

  _diskQuota(tenant) {
    return this._quota(tenant).diskBytes ?? Infinity;
  }

  _usedBytes(tenant) {
    const committed = this.tenants.get(tenant)?.bytes ?? 0;
    const buffered = this.bufferedTenantBytes.get(tenant) ?? 0;
    return committed + buffered;
  }

  root() {
    return this.lastHash.toString('hex');
  }

  append(record) {
    if (this.crashed) throw new AuditError('CORRUPT', 'log is crashed; reopen after recover');
    if (this.readonly) throw new AuditError('READONLY', 'log opened read-only');
    if (!record || typeof record.tenant !== 'string' || !Number.isInteger(record.seq)) {
      throw new AuditError('CORRUPT', 'record must have tenant:string and seq:integer');
    }
    const committed = this.tenants.get(record.tenant)?.lastSeq ?? -1;
    const expected = (this.bufferedSeq.get(record.tenant) ?? committed) + 1;
    if (record.seq !== expected) {
      throw new AuditError('SEQ_GAP', `tenant ${record.tenant}: expected seq ${expected}, got ${record.seq}`, {
        tenant: record.tenant, expected, got: record.seq,
      });
    }
    const bytes = recordBytes(record);
    const diskQuota = this._diskQuota(record.tenant);
    if (this._usedBytes(record.tenant) + bytes > diskQuota) {
      throw new AuditError('QUOTA', `tenant ${record.tenant}: disk quota ${diskQuota} exceeded`, {
        tenant: record.tenant, diskBytes: diskQuota,
      });
    }
    this.scheduler.enqueue({ tenant: record.tenant, record, bytes });
    this.bufferedSeq.set(record.tenant, record.seq);
    this.bufferedTenantBytes.set(record.tenant, (this.bufferedTenantBytes.get(record.tenant) ?? 0) + bytes);
    this.bufferedBytes += bytes;
    if (this.bufferedBytes >= this.bufferPages * maxPayloadSize(this.pageSize)) this.flush();
    return bytes;
  }

  // Drain the scheduler into pages. Commit point: fsync after each page write.
  flush() {
    if (this.crashed) throw new AuditError('CORRUPT', 'log is crashed; reopen after recover');
    if (this.readonly) {
      if (this.scheduler.size > 0) throw new AuditError('READONLY', 'log opened read-only');
      return;
    }
    const capacity = maxPayloadSize(this.pageSize);
    while (this.scheduler.size > 0) {
      const records = [];
      let payloadBytes = 0;
      const packed = [];
      const blocked = new Set(); // tenants whose head record does not fit this page
      for (;;) {
        const item = this.scheduler.peek(blocked);
        if (!item) break;
        if (payloadBytes + item.bytes > capacity) {
          if (records.length === 0) {
            throw new AuditError('QUOTA', `record of ${item.bytes} bytes exceeds page capacity ${capacity}`);
          }
          blocked.add(item.tenant); // leave it queued; per-tenant order is preserved
          continue;
        }
        const taken = this.scheduler.next(blocked);
        records.push(taken.record);
        payloadBytes += taken.bytes;
        packed.push(taken);
      }
      if (records.length === 0) break;
      const { page, pageHash } = encodePage({
        pageIndex: this.committedPages,
        records,
        prevHash: this.lastHash,
        pageSize: this.pageSize,
      });
      fs.writeSync(this.fd, page, 0, page.length, this.committedPages * this.pageSize);
      if (this.onBeforeFsync) this.onBeforeFsync(this.committedPages); // crash-injection hook
      fs.fsyncSync(this.fd); // commit point
      this.committedPages += 1;
      this.lastHash = pageHash;
      for (const item of packed) {
        const t = this.tenants.get(item.tenant) ?? { lastSeq: -1, bytes: 0, count: 0 };
        t.lastSeq = item.record.seq;
        t.bytes += item.bytes;
        t.count += 1;
        this.tenants.set(item.tenant, t);
        this.bufferedTenantBytes.set(item.tenant, (this.bufferedTenantBytes.get(item.tenant) ?? 0) - item.bytes);
        this.bufferedBytes -= item.bytes;
      }
    }
  }

  // Simulate a crash: everything not fsynced is lost (deterministically zeroed,
  // modelling a torn/uncommitted tail), buffers are dropped, fd closed.
  simulateCrash() {
    if (this.crashed) return;
    const durable = this.committedPages * this.pageSize;
    if (this.fd !== null) {
      const size = fs.fstatSync(this.fd).size;
      if (size > durable) fs.writeSync(this.fd, Buffer.alloc(size - durable, 0), 0, size - durable, durable);
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
    }
    this.crashed = true;
  }

  close() {
    if (this.fd !== null && !this.crashed) fs.closeSync(this.fd);
    this.fd = null;
  }

  stats() {
    const tenants = {};
    for (const [name, t] of this.tenants) tenants[name] = { count: t.count, bytes: t.bytes };
    return { pages: this.committedPages, buffered: this.scheduler.size, tenants };
  }
}
