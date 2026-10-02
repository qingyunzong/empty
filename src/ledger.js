import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendRecord, scanLog, truncateLog, LedgerError } from './log.js';

const STATE_TYPES = new Set(['receive', 'reserve', 'issue', 'return']);

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function isQty(q) {
  return Number.isInteger(q) && q > 0;
}

// Exact proportional split of `total` across parts [{id, avail}] using
// integer floor + largest-remainder, ties broken by input order.
export function distribute(total, parts) {
  const sum = parts.reduce((a, p) => a + p.avail, 0);
  const shares = parts.map((p) => {
    const prod = total * p.avail;
    return { batch: p.id, qty: Math.floor(prod / sum), rem: prod % sum };
  });
  let leftover = total - shares.reduce((a, s) => a + s.qty, 0);
  const order = shares
    .map((s, i) => i)
    .sort((a, b) => shares[b].rem - shares[a].rem || a - b);
  for (let k = 0; leftover > 0; k = (k + 1) % order.length) {
    shares[order[k]].qty++;
    leftover--;
  }
  return shares.map(({ batch, qty }) => ({ batch, qty }));
}

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.logPath = path.join(dir, 'events.log');
    this.manifestPath = path.join(dir, 'snapshot.json');
  }

  static init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return new Ledger(dir).open();
  }

  open() {
    this.records = [];
    this.batches = new Map();       // id -> {id, material, parent, received, issued, seq}
    this.reservations = new Map();  // key -> {key, batch, qty, consumed, seq}
    this.keys = new Map();          // client idempotency key -> stored result
    this.savepoints = new Map();    // name -> {name, eventIndex, byteOffset}
    this.compensated = new Set();   // event keys already reversed by a rollback
    this.certificates = [];
    this.clock = 0;

    const { records, corruptOffset, reason } = scanLog(this.logPath);
    if (corruptOffset !== null) {
      throw new LedgerError('E_CRC', `corrupt block at offset ${corruptOffset} (${reason})`, { offset: corruptOffset });
    }
    for (const { offset, record } of records) {
      record.offset = offset;
      this.records.push(record);
      this.#replay(record);
    }
    this.manifest = this.#readManifest();
    return this;
  }

  // ---------- replay / append ----------

  #replay(rec) {
    const { event, result } = rec;
    switch (event.type) {
      case 'receive': if (result.ok) this.#applyReceive(event); break;
      case 'reserve': if (result.ok) this.#applyReserve(event); break;
      case 'issue':   if (result.ok) this.#applyIssue(event, result.detail); break;
      case 'return':  if (result.ok) this.#applyReturn(event); break;
      case 'savepoint':
        this.savepoints.set(event.name, { name: event.name, eventIndex: rec.seq, byteOffset: rec.offset ?? 0 });
        break;
      case 'compensate':
        this.#applyInverse(event.inverse);
        break;
      case 'rollback':
        this.certificates.push(event.certificate);
        for (const k of event.compensatedKeys) this.compensated.add(k);
        break;
      default:
        throw new LedgerError('E_INTERNAL', `unknown event type ${event.type}`);
    }
    if (event.key) this.keys.set(event.key, result);
  }

  #append(event, result) {
    const rec = { seq: this.records.length, event, result };
    const { offset } = appendRecord(this.logPath, rec);
    rec.offset = offset;
    this.records.push(rec);
    this.#replay(rec);
    return result;
  }

  // ---------- state queries ----------

  #subtree(id) {
    const byParent = new Map();
    for (const b of this.batches.values()) {
      if (b.parent === null) continue;
      if (!byParent.has(b.parent)) byParent.set(b.parent, []);
      byParent.get(b.parent).push(b);
    }
    const out = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      const b = this.batches.get(cur);
      if (b) out.push(b);
      for (const c of byParent.get(cur) || []) stack.push(c.id);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  #subtreeStock(id) {
    return this.#subtree(id).reduce((a, b) => a + (b.received - b.issued), 0);
  }

  #activeReserved(batchId) {
    let sum = 0;
    for (const r of this.reservations.values()) {
      if (r.batch === batchId) sum += r.qty - r.consumed;
    }
    return sum;
  }

  balances() {
    const out = [];
    for (const b of [...this.batches.values()].sort((a, b2) => a.seq - b2.seq)) {
      out.push({
        batch: b.id,
        material: b.material,
        parent: b.parent,
        received: b.received,
        issued: b.issued,
        available: b.received - b.issued,
        reserved: this.#activeReserved(b.id),
        subtreeAvailable: this.#subtreeStock(b.id),
      });
    }
    return out;
  }

  // ---------- mutating operations ----------

  #dup(key) {
    if (key !== undefined && this.keys.has(key)) {
      return { ...this.keys.get(key), duplicate: true };
    }
    return null;
  }

  #checked(key, fn) {
    if (key === undefined || key === null || key === '') {
      return { ok: false, code: 'E_ARG', message: 'idempotency key is required' };
    }
    const dup = this.#dup(key);
    if (dup) return dup;
    const result = fn();
    const event = result.__event;
    delete result.__event;
    return this.#append(event, result);
  }

  receive({ key, batch, material, qty, parent = null }) {
    return this.#checked(key, () => {
      const event = { type: 'receive', key, batch, material, qty, parent };
      if (!batch || !material || !isQty(qty)) {
        return { ok: false, code: 'E_ARG', message: 'batch, material and positive integer qty required', __event: event };
      }
      if (parent !== null && !this.batches.has(parent)) {
        return { ok: false, code: 'E_STOCK', message: `unknown parent batch ${parent}`, __event: event };
      }
      const existing = this.batches.get(batch);
      if (existing && (existing.material !== material || existing.parent !== parent)) {
        return { ok: false, code: 'E_ARG', message: `batch ${batch} exists with different material/parent`, __event: event };
      }
      const detail = { batch, created: !existing };
      return { ok: true, code: 'OK', detail, __event: event };
    });
  }

  reserve({ key, batch, qty }) {
    return this.#checked(key, () => {
      const event = { type: 'reserve', key, batch, qty };
      const b = this.batches.get(batch);
      if (!b || !isQty(qty)) {
        return { ok: false, code: 'E_STOCK', message: `unknown batch ${batch} or bad qty`, __event: event };
      }
      const available = this.#subtreeStock(batch) - this.#activeReserved(batch);
      if (qty > available) {
        return { ok: false, code: 'E_STOCK', message: `reserve ${qty} exceeds available ${available}`, __event: event };
      }
      return { ok: true, code: 'OK', detail: { reservation: key, batch }, __event: event };
    });
  }

  issue({ key, batch, qty }) {
    return this.#checked(key, () => {
      const event = { type: 'issue', key, batch, qty };
      const b = this.batches.get(batch);
      if (!b || !isQty(qty)) {
        return { ok: false, code: 'E_STOCK', message: `unknown batch ${batch} or bad qty`, __event: event };
      }
      const budget = this.#activeReserved(batch);
      if (budget > 0 && qty > budget) {
        return { ok: false, code: 'E_STOCK', message: `issue ${qty} exceeds reservation budget ${budget}`, __event: event };
      }
      const parts = this.#subtree(batch)
        .map((x) => ({ id: x.id, avail: x.received - x.issued }))
        .filter((p) => p.avail > 0);
      const total = parts.reduce((a, p) => a + p.avail, 0);
      if (qty > total) {
        return { ok: false, code: 'E_STOCK', message: `issue ${qty} exceeds stock ${total}`, __event: event };
      }
      const distribution = distribute(qty, parts);
      // consume reservation budget FIFO by reservation seq
      const consumed = [];
      let remaining = qty;
      for (const r of [...this.reservations.values()].sort((a, b2) => a.seq - b2.seq)) {
        if (r.batch !== batch || remaining === 0) continue;
        const take = Math.min(remaining, r.qty - r.consumed);
        if (take > 0) {
          consumed.push({ reservation: r.key, qty: take });
          remaining -= take;
        }
      }
      return { ok: true, code: 'OK', detail: { distribution, consumed }, __event: event };
    });
  }

  returnMaterial({ key, batch, qty }) {
    return this.#checked(key, () => {
      const event = { type: 'return', key, batch, qty };
      const b = this.batches.get(batch);
      if (!b || !isQty(qty)) {
        return { ok: false, code: 'E_STOCK', message: `unknown batch ${batch} or bad qty`, __event: event };
      }
      if (qty > b.issued) {
        return { ok: false, code: 'E_STOCK', message: `return ${qty} exceeds issued ${b.issued}`, __event: event };
      }
      return { ok: true, code: 'OK', detail: { batch }, __event: event };
    });
  }

  savepoint(name) {
    if (!name) return { ok: false, code: 'E_ARG', message: 'savepoint name required' };
    const key = `sp:${name}`;
    const dup = this.#dup(key);
    if (dup) return dup;
    const event = { type: 'savepoint', key, name };
    const result = this.#append(event, { ok: true, code: 'OK', detail: { savepoint: name } });
    this.#writeManifest();
    return result;
  }

  rollback(to) {
    const sp = this.savepoints.get(to);
    if (!sp) {
      return { ok: false, code: 'E_SAVEPOINT', message: `unknown savepoint ${to}` };
    }
    const targets = this.records.filter(
      (r) => r.seq > sp.eventIndex && STATE_TYPES.has(r.event.type) && r.result.ok && !this.compensated.has(r.event.key),
    );
    for (const rec of [...targets].reverse()) {
      const inverse = inverseOf(rec);
      this.#append(
        { type: 'compensate', key: `cmp:${rec.event.key}`, of: rec.event.key, inverse },
        { ok: true, code: 'OK', detail: { compensates: rec.event.key } },
      );
    }
    const certificate = {
      savepoint: to,
      count: targets.length,
      keys: targets.map((r) => r.event.key),
      hash: sha256hex(JSON.stringify(targets.map((r) => [r.event, r.result]))),
      at: new Date().toISOString(),
    };
    const event = { type: 'rollback', key: `rb:${to}:${this.records.length}`, to, certificate, compensatedKeys: certificate.keys };
    this.#append(event, { ok: true, code: 'OK', detail: { certificate } });
    this.#writeManifest();
    return { ok: true, code: 'OK', certificate };
  }

  // ---------- apply effects (used by replay and live append) ----------

  #applyReceive(event) {
    let b = this.batches.get(event.batch);
    if (!b) {
      b = { id: event.batch, material: event.material, parent: event.parent, received: 0, issued: 0, seq: this.clock++ };
      this.batches.set(event.batch, b);
    }
    b.received += event.qty;
  }

  #applyReserve(event) {
    this.reservations.set(event.key, { key: event.key, batch: event.batch, qty: event.qty, consumed: 0, seq: this.clock++ });
  }

  #applyIssue(event, detail) {
    for (const d of detail.distribution) this.batches.get(d.batch).issued += d.qty;
    for (const c of detail.consumed) this.reservations.get(c.reservation).consumed += c.qty;
  }

  #applyReturn(event) {
    this.batches.get(event.batch).issued -= event.qty;
  }

  #applyInverse(inv) {
    switch (inv.op) {
      case 'unreceive': {
        const b = this.batches.get(inv.batch);
        b.received -= inv.qty;
        if (inv.created) this.batches.delete(inv.batch);
        break;
      }
      case 'unreserve':
        this.reservations.delete(inv.reservation);
        break;
      case 'unissue':
        for (const d of inv.distribution) this.batches.get(d.batch).issued -= d.qty;
        for (const c of inv.consumed) this.reservations.get(c.reservation).consumed -= c.qty;
        break;
      case 'unreturn':
        this.batches.get(inv.batch).issued += inv.qty;
        break;
      default:
        throw new LedgerError('E_INTERNAL', `unknown inverse op ${inv.op}`);
    }
  }

  // ---------- snapshot manifest ----------

  #stateHash() {
    return sha256hex(JSON.stringify(this.balances()));
  }

  #writeManifest() {
    const manifest = {
      version: 1,
      eventCount: this.records.length,
      stateHash: this.#stateHash(),
      savepoints: [...this.savepoints.values()],
      updatedAt: new Date().toISOString(),
    };
    const tmp = this.manifestPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, this.manifestPath); // atomic publish; crash before rename keeps old snapshot
    this.manifest = manifest;
    return manifest;
  }

  snapshot() {
    return { ok: true, code: 'OK', manifest: this.#writeManifest() };
  }

  #readManifest() {
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch {
      return null; // missing or half-written manifest: log is the source of truth
    }
  }
}

function inverseOf(rec) {
  const { event, result } = rec;
  switch (event.type) {
    case 'receive':
      return { op: 'unreceive', batch: event.batch, qty: event.qty, created: result.detail.created };
    case 'reserve':
      return { op: 'unreserve', reservation: event.key };
    case 'issue':
      return { op: 'unissue', distribution: result.detail.distribution, consumed: result.detail.consumed };
    case 'return':
      return { op: 'unreturn', batch: event.batch, qty: event.qty };
    default:
      throw new LedgerError('E_INTERNAL', `cannot invert ${event.type}`);
  }
}

// Truncates the log at the first corrupt block so the last good
// (savepoint-consistent) state can be replayed.
export function recoverLedger(dir) {
  const logPath = path.join(dir, 'events.log');
  const { corruptOffset, reason } = scanLog(logPath);
  if (corruptOffset === null) return { ok: true, code: 'OK', recovered: false };
  truncateLog(logPath, corruptOffset);
  return { ok: true, code: 'OK', recovered: true, truncatedAt: corruptOffset, reason };
}
