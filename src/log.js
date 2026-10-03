import fs from 'node:fs';
import path from 'node:path';
import { CODES, LogError } from './errors.js';
import {
  PAGE_MAGIC,
  HEADER_SIZE,
  COMMIT_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  GENESIS_HASH,
  EMPTY_ROOT,
  payloadCapacity,
  stride,
  sha256,
  pageHash,
  encodePage,
  encodeCommit,
  decodePage,
  validatePage,
  validateCommit,
} from './page.js';
import { FairScheduler } from './scheduler.js';
import { FileStorage } from './storage.js';

export function serializeEvent(event, seq) {
  return JSON.stringify({ ...event, seq }) + '\n';
}

// Deterministically scans the log and finds the last consistent page.
// Returns the rebuilt index plus any orphan (uncommitted/corrupt) tail.
export function scanStorage(storage) {
  const violations = [];
  const result = {
    pageSize: 0,
    pages: [],
    events: [],
    lastSeq: 0,
    root: EMPTY_ROOT,
    headHash: GENESIS_HASH,
    validBytes: 0,
    orphan: null,
    violations,
    tenantBytes: new Map(),
  };
  const total = storage.size();
  if (total === 0) return result;

  let expectedSeq = 1;
  const fail = (violation, orphanOffset) => {
    violations.push(violation);
    result.orphan = { offset: orphanOffset, length: total - orphanOffset };
    result.lastSeq = expectedSeq - 1;
    return result;
  };

  const head = storage.read(0, HEADER_SIZE);
  if (head.length < 12 || !head.subarray(0, 8).equals(PAGE_MAGIC)) {
    return fail({ code: CODES.CORRUPT, page: 0, detail: 'bad magic or truncated header' }, 0);
  }
  const pageSize = head.readUInt32BE(8);
  if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
    return fail({ code: CODES.CORRUPT, page: 0, detail: `invalid page size ${pageSize}` }, 0);
  }
  result.pageSize = pageSize;
  const pageStride = stride(pageSize);

  let offset = 0;
  let expectedIndex = 0;
  let prevHash = GENESIS_HASH;

  while (offset < total) {
    if (offset + pageSize > total) {
      return fail({ code: CODES.CORRUPT, page: expectedIndex, offset, detail: 'truncated page' }, offset);
    }
    const buf = storage.read(offset, pageSize);
    const pageViolation = validatePage(buf, {
      expectedIndex,
      expectedPrevHash: prevHash,
      expectedFirstSeq: expectedSeq,
    });
    if (pageViolation) return fail({ ...pageViolation, offset }, offset);

    const commitBuf = storage.read(offset + pageSize, COMMIT_SIZE);
    const commitViolation = validateCommit(commitBuf, expectedIndex, pageHash(buf));
    if (commitViolation) return fail({ ...commitViolation, offset }, offset);

    const page = decodePage(buf);
    const text = page.payload.toString('utf8');
    if (!text.endsWith('\n')) {
      return fail({ code: CODES.CORRUPT, page: expectedIndex, offset, detail: 'payload not newline terminated' }, offset);
    }
    const lines = text.slice(0, -1).split('\n');
    if (lines.length !== page.eventCount) {
      return fail({ code: CODES.CORRUPT, page: expectedIndex, offset, detail: 'event count mismatch' }, offset);
    }
    const pageEvents = [];
    for (let i = 0; i < lines.length; i++) {
      let event;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        return fail({ code: CODES.CORRUPT, page: expectedIndex, offset, detail: 'event is not valid JSON' }, offset);
      }
      if (event.seq !== expectedSeq + i) {
        return fail({
          code: CODES.SEQ_GAP,
          page: expectedIndex,
          offset,
          detail: `expected seq ${expectedSeq + i}, got ${event.seq}`,
        }, offset);
      }
      if (typeof event.tenant !== 'string') {
        return fail({ code: CODES.CORRUPT, page: expectedIndex, offset, detail: 'event missing tenant' }, offset);
      }
      const bytes = Buffer.byteLength(lines[i]) + 1;
      result.tenantBytes.set(event.tenant, (result.tenantBytes.get(event.tenant) ?? 0) + bytes);
      pageEvents.push(event);
    }

    const hash = pageHash(buf);
    result.pages.push({ index: expectedIndex, offset, firstSeq: page.firstSeq, eventCount: page.eventCount, hash });
    result.events.push(...pageEvents);
    result.headHash = hash;
    result.root = hash.toString('hex');
    prevHash = hash;
    expectedSeq += page.eventCount;
    expectedIndex++;
    offset += pageStride;
    result.validBytes = offset;
  }

  result.lastSeq = expectedSeq - 1;
  return result;
}

export class AuditLog {
  constructor({
    storage,
    dir = null,
    pageSize = 4096,
    quotas = {},
    priorities = {},
    capacity = 4096,
    agingRate = 1,
    readonly = false,
  } = {}) {
    this.storage = storage;
    this.dir = dir;
    this.quotas = quotas;
    this.priorities = priorities;
    this.capacity = capacity;
    this.agingRate = agingRate;
    this.readonly = readonly;
    this.pageSize = pageSize;
    this.lastRecovery = null;
    this._resetIndex();
  }

  _resetIndex() {
    this.pageCount = 0;
    this.lastSeq = 0;
    this.totalEvents = 0;
    this.headHash = GENESIS_HASH;
    this.root = EMPTY_ROOT;
    this.tail = 0;
    this.tenantBytes = new Map();
  }

  _rebuildIndex(scan) {
    this.pageCount = scan.pages.length;
    this.lastSeq = scan.lastSeq;
    this.totalEvents = scan.events.length;
    this.headHash = scan.headHash;
    this.root = scan.root;
    this.tail = scan.validBytes;
    this.tenantBytes = scan.tenantBytes;
    if (scan.pageSize > 0) this.pageSize = scan.pageSize;
  }

  // Read-only open: rebuild in-memory index from the consistent prefix.
  scanOnly() {
    const scan = scanStorage(this.storage);
    this._rebuildIndex(scan);
    return scan;
  }

  // Recovers to the last consistent page: truncates any uncommitted/corrupt
  // tail and moves the orphan bytes to quarantine with a proof. Deterministic:
  // running it twice on the same state yields the same root and proof.
  recover() {
    if (this.readonly) {
      throw new LogError(CODES.READONLY, 'cannot recover a read-only log');
    }
    const scan = scanStorage(this.storage);
    let quarantine = null;
    if (scan.orphan) {
      const bytes = this.storage.read(scan.orphan.offset, scan.orphan.length);
      quarantine = {
        offset: scan.orphan.offset,
        length: scan.orphan.length,
        sha256: sha256(bytes).toString('hex'),
        headPageIndex: scan.pages.length - 1,
        headHash: scan.root,
        reason: scan.violations[0]?.code ?? CODES.CORRUPT,
      };
      this.storage.truncate(scan.validBytes);
      this.storage.fsync();
      if (this.dir) {
        fs.appendFileSync(path.join(this.dir, 'quarantine.jsonl'), JSON.stringify(quarantine) + '\n');
        fs.appendFileSync(path.join(this.dir, 'quarantine.bin'), bytes);
      }
    }
    this._rebuildIndex(scan);
    this.lastRecovery = {
      pages: scan.pages.length,
      events: scan.events.length,
      lastSeq: scan.lastSeq,
      truncatedBytes: scan.orphan?.length ?? 0,
      quarantine,
      violations: scan.violations,
    };
    return this.lastRecovery;
  }

  // Read-only verification of the full hash chain and commit records.
  verify() {
    const scan = scanStorage(this.storage);
    const violations = [...scan.violations];
    if (scan.orphan && violations.length === 0) {
      violations.push({ code: CODES.CORRUPT, offset: scan.orphan.offset, detail: 'uncommitted tail bytes' });
    }
    return {
      valid: violations.length === 0,
      violations,
      root: scan.root,
      stats: {
        pages: scan.pages.length,
        events: scan.events.length,
        lastSeq: scan.lastSeq,
        bytes: this.storage.size(),
      },
    };
  }

  // Schedules events through the quota/fairness layer, then appends them as
  // hash-chained pages, fsyncing each page (the commit point).
  append(inputEvents) {
    if (this.readonly) {
      throw new LogError(CODES.READONLY, 'cannot append to a read-only log');
    }
    const violations = [];
    const events = [];
    for (const event of inputEvents) {
      if (!event || typeof event.tenant !== 'string') {
        violations.push({ code: CODES.CORRUPT, detail: 'event missing tenant', event: event ?? null });
      } else {
        events.push(event);
      }
    }

    const base = this.lastSeq;
    const scheduler = new FairScheduler({
      quotas: this.quotas,
      priorities: this.priorities,
      capacity: this.capacity,
      agingRate: this.agingRate,
      // Exact serialized size: the k-th admitted event gets seq base+k+1, and
      // skipped events only ever lower later seqs, so estimates never
      // under-count and the hard disk quota holds exactly.
      sizeOf: (event, k) => Buffer.byteLength(serializeEvent(event, base + k + 1)),
    });
    for (const [tenant, bytes] of this.tenantBytes) scheduler.setUsedBytes(tenant, bytes);
    const scheduled = scheduler.run(events);
    violations.push(...scheduled.violations);

    const capacityBytes = payloadCapacity(this.pageSize);
    const accepted = [];
    for (const rec of scheduled.admitted) {
      const seq = base + accepted.length + 1;
      const line = serializeEvent(rec.event, seq);
      if (line.length > capacityBytes) {
        violations.push({
          code: CODES.QUOTA,
          tenant: rec.event.tenant,
          detail: `event of ${line.length} bytes exceeds page capacity ${capacityBytes}`,
        });
        continue;
      }
      if (rec.event.seq != null && rec.event.seq !== seq) {
        violations.push({
          code: CODES.SEQ_GAP,
          tenant: rec.event.tenant,
          detail: `expected seq ${seq}, got ${rec.event.seq}`,
        });
        continue;
      }
      accepted.push({ line, event: { ...rec.event, seq } });
    }

    let batch = [];
    let batchBytes = 0;
    let batchFirstSeq = 0;
    const flush = () => {
      if (batch.length === 0) return;
      this._writePage(batch, batchFirstSeq);
      batch = [];
      batchBytes = 0;
    };
    for (const { line, event } of accepted) {
      if (batch.length === 0) batchFirstSeq = event.seq;
      if (batchBytes + line.length > capacityBytes) {
        flush();
        batchFirstSeq = event.seq;
      }
      batch.push(line);
      batchBytes += line.length;
      this.tenantBytes.set(event.tenant, (this.tenantBytes.get(event.tenant) ?? 0) + line.length);
    }
    flush();

    this.lastSeq += accepted.length;
    this.totalEvents += accepted.length;
    return {
      appended: accepted.length,
      events: accepted.map((a) => a.event),
      violations,
      root: this.root,
    };
  }

  _writePage(lines, firstSeq) {
    const payload = Buffer.from(lines.join(''), 'utf8');
    const page = encodePage({
      pageIndex: this.pageCount,
      firstSeq,
      eventCount: lines.length,
      payload,
      prevHash: this.headHash,
      pageSize: this.pageSize,
    });
    const hash = pageHash(page);
    const commit = encodeCommit({ pageIndex: this.pageCount, hash });
    this.storage.write(this.tail, Buffer.concat([page, commit]));
    this.storage.fsync();
    this.tail += page.length + commit.length;
    this.headHash = hash;
    this.root = hash.toString('hex');
    this.pageCount++;
  }

  stats() {
    return {
      pages: this.pageCount,
      events: this.totalEvents,
      lastSeq: this.lastSeq,
      tenantBytes: Object.fromEntries(this.tenantBytes),
    };
  }

  close() {
    this.storage.close?.();
  }
}

// Opens a directory-based log. Writable opens recover to the last consistent
// page before use; a `READONLY` marker file in the directory (or
// opts.readonly) opens the log read-only and append/recover fail with
// READONLY.
export function openLog(dir, opts = {}) {
  const readonly = Boolean(opts.readonly) || fs.existsSync(path.join(dir, 'READONLY'));
  if (!readonly) fs.mkdirSync(dir, { recursive: true });
  const storage = new FileStorage(path.join(dir, 'events.log'), { readonly });
  const log = new AuditLog({ ...opts, storage, dir, readonly });
  if (readonly) {
    log.scanOnly();
  } else {
    log.recover();
  }
  return log;
}
