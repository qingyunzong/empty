import { QError } from './errors.js';
import { TimezoneTable } from './timezone.js';
import { QualityWindow } from './window.js';
import { IntervalSet } from './intervals.js';

const ISSUABLE_STATES = new Set(['available', 'released']);
const TRANSITIONS = {
  available: 'available',
  quarantine: 'quarantined',
  release: 'released',
  scrap: 'scrapped',
};

function parseInstant(value, field) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new QError('INVALID_COMMAND', `invalid instant for "${field}": ${value}`);
  }
  return ms;
}

function parseQuantity(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new QError('INVALID_COMMAND', `"${field}" must be a positive integer`);
  }
  return value;
}

export class Store {
  constructor() {
    this.timezones = new TimezoneTable({});
    this.window = null;
    this.defects = new IntervalSet();
    this.batches = new Map();
    this.issues = new Map();
    this.certificates = [];
    this.lastEventAt = Number.NEGATIVE_INFINITY;
    this.issueSeq = 0;
    this.orderSeq = 0;
  }

  apply(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.cmd !== 'string') {
      throw new QError('INVALID_COMMAND', 'command must be an object with a "cmd" string');
    }
    switch (cmd.cmd) {
      case 'config': return this.#config(cmd);
      case 'defects': return this.#addDefects(cmd);
      case 'receive': return this.#receive(cmd);
      case 'available':
      case 'quarantine':
      case 'release':
      case 'scrap': return this.#transition(cmd);
      case 'inspect': return this.#inspect(cmd);
      case 'issue': return this.#issue(cmd);
      case 'undo': return this.#undo(cmd);
      case 'restore': return this.#restore(cmd);
      case 'issuable': return this.#issuable(cmd);
      case 'status': return this.#status();
      default: throw new QError('INVALID_COMMAND', `unknown command "${cmd.cmd}"`);
    }
  }

  #touch(ms) {
    if (ms > this.lastEventAt) this.lastEventAt = ms;
  }

  #getBatch(id) {
    const batch = this.batches.get(id);
    if (!batch) throw new QError('UNKNOWN_BATCH', `unknown batch "${id}"`);
    return batch;
  }

  #config(cmd) {
    const timezones = new TimezoneTable(cmd.timezones ?? {});
    const window = new QualityWindow(cmd.window, timezones);
    this.timezones = timezones;
    this.window = window;
    if (Array.isArray(cmd.defects)) {
      for (const pair of cmd.defects) this.#addDefectPair(pair);
    }
    return { ok: true, type: 'config' };
  }

  #addDefectPair(pair) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new QError('INVALID_COMMAND', 'defect interval must be [start, end]');
    }
    this.defects.add(parseInstant(pair[0], 'defect start'), parseInstant(pair[1], 'defect end'));
  }

  #addDefects(cmd) {
    if (!Array.isArray(cmd.add)) {
      throw new QError('INVALID_COMMAND', 'defects command needs an "add" array');
    }
    for (const pair of cmd.add) this.#addDefectPair(pair);
    return { ok: true, type: 'defects', count: this.defects.intervals.length };
  }

  #receive(cmd) {
    if (typeof cmd.batch !== 'string' || cmd.batch === '') {
      throw new QError('INVALID_COMMAND', 'receive needs a "batch" id');
    }
    if (this.batches.has(cmd.batch)) {
      throw new QError('DUPLICATE_BATCH', `batch "${cmd.batch}" already exists`);
    }
    const qty = parseQuantity(cmd.qty, 'qty');
    const expiry = parseInstant(cmd.expiry, 'expiry');
    if (!Array.isArray(cmd.span) || cmd.span.length !== 2) {
      throw new QError('INVALID_COMMAND', 'receive needs a "span" [start, end]');
    }
    const span = [parseInstant(cmd.span[0], 'span start'), parseInstant(cmd.span[1], 'span end')];
    if (span[0] > span[1]) {
      throw new QError('INVALID_COMMAND', 'span start must not exceed span end');
    }
    const at = cmd.at == null ? null : parseInstant(cmd.at, 'at');
    this.batches.set(cmd.batch, {
      id: cmd.batch,
      qty,
      expiry,
      span,
      state: 'received',
      inspection: null,
    });
    if (at != null) this.#touch(at);
    return { ok: true, type: 'receive', batch: cmd.batch, qty };
  }

  #transition(cmd) {
    const batch = this.#getBatch(cmd.batch);
    const next = TRANSITIONS[cmd.cmd];
    if (batch.state === 'scrapped') {
      throw new QError('INVALID_STATE', `batch "${batch.id}" is scrapped`);
    }
    batch.state = next;
    if (cmd.at != null) this.#touch(parseInstant(cmd.at, 'at'));
    return { ok: true, type: cmd.cmd, batch: batch.id, state: next };
  }

  #inspect(cmd) {
    const batch = this.#getBatch(cmd.batch);
    if (!this.window) {
      throw new QError('ILLEGAL_PERIOD', 'no quality window configured');
    }
    const inspectedAt = parseInstant(cmd.inspectedAt, 'inspectedAt');
    if (!this.window.contains(inspectedAt)) {
      throw new QError('OUTSIDE_WINDOW', `inspection at ${new Date(inspectedAt).toISOString()} is outside the quality window`);
    }
    const recordedAt = cmd.at == null ? inspectedAt : parseInstant(cmd.at, 'at');
    const passed = Boolean(cmd.passed);
    const late = inspectedAt < this.lastEventAt;
    batch.inspection = { inspectedAt, recordedAt, passed };
    this.#touch(recordedAt);
    const result = { ok: true, type: 'inspect', batch: batch.id, passed, late };
    if (late) {
      // Incremental recompute: only this batch's issuability changes, and only
      // issues at or after the (retroactive) inspection instant are affected.
      const certificates = this.#recomputeFrom(batch, inspectedAt);
      if (certificates.length > 0) result.certificates = certificates;
    }
    return result;
  }

  // Issued stock is never auto-recalled; affected downstream orders get a
  // certificate instead.
  #recomputeFrom(batch, sinceMs) {
    const fresh = [];
    if (batch.inspection?.passed) return fresh;
    for (const issue of this.issues.values()) {
      if (issue.undone || issue.at < sinceMs) continue;
      for (const alloc of issue.allocations) {
        if (alloc.batch !== batch.id) continue;
        const cert = {
          type: 'AFFECTED_DOWNSTREAM_CERTIFICATE',
          orderId: issue.orderId,
          issueId: issue.id,
          batch: batch.id,
          qty: alloc.qty,
          issuedAt: new Date(issue.at).toISOString(),
          reason: 'late-inspection-failed',
        };
        this.certificates.push(cert);
        fresh.push(cert);
      }
    }
    return fresh;
  }

  #issuableAt(batch, at) {
    return ISSUABLE_STATES.has(batch.state) &&
      batch.inspection !== null &&
      batch.inspection.passed &&
      batch.inspection.inspectedAt <= at &&
      !this.defects.overlaps(batch.span[0], batch.span[1]);
  }

  #fefoCandidates(at) {
    const list = [];
    for (const batch of this.batches.values()) {
      if (batch.qty > 0 && this.#issuableAt(batch, at)) list.push(batch);
    }
    list.sort((a, b) => a.expiry - b.expiry || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return list;
  }

  #issue(cmd) {
    const qty = parseQuantity(cmd.qty, 'qty');
    const at = parseInstant(cmd.at, 'at');
    const orderId = cmd.orderId ?? `ORD-${++this.orderSeq}`;
    const candidates = this.#fefoCandidates(at);
    const total = candidates.reduce((sum, b) => sum + b.qty, 0);
    if (total < qty) {
      throw new QError('NEGATIVE_INVENTORY', `issue of ${qty} exceeds issuable stock ${total}`);
    }
    const allocations = [];
    let remaining = qty;
    for (const batch of candidates) {
      if (remaining === 0) break;
      const take = Math.min(batch.qty, remaining);
      batch.qty -= take;
      allocations.push({ batch: batch.id, qty: take });
      remaining -= take;
    }
    const id = `I${++this.issueSeq}`;
    this.issues.set(id, { id, orderId, at, allocations, undone: false });
    this.#touch(at);
    return { ok: true, type: 'issue', issueId: id, orderId, at: new Date(at).toISOString(), allocations };
  }

  #undo(cmd) {
    const issue = this.issues.get(cmd.issueId);
    if (!issue) throw new QError('UNKNOWN_ISSUE', `unknown issue "${cmd.issueId}"`);
    if (issue.undone) throw new QError('INVALID_STATE', `issue "${issue.id}" is already undone`);
    for (const alloc of issue.allocations) {
      this.batches.get(alloc.batch).qty += alloc.qty;
    }
    issue.undone = true;
    return { ok: true, type: 'undo', issueId: issue.id };
  }

  #restore(cmd) {
    const issue = this.issues.get(cmd.issueId);
    if (!issue) throw new QError('UNKNOWN_ISSUE', `unknown issue "${cmd.issueId}"`);
    if (!issue.undone) throw new QError('INVALID_STATE', `issue "${issue.id}" is not undone`);
    for (const alloc of issue.allocations) {
      const batch = this.batches.get(alloc.batch);
      if (batch.qty < alloc.qty) {
        throw new QError('NEGATIVE_INVENTORY', `restore of "${issue.id}" would drive batch "${batch.id}" negative`);
      }
    }
    for (const alloc of issue.allocations) {
      this.batches.get(alloc.batch).qty -= alloc.qty;
    }
    issue.undone = false;
    return { ok: true, type: 'restore', issueId: issue.id };
  }

  #issuable(cmd) {
    const at = cmd.at == null ? this.lastEventAt : parseInstant(cmd.at, 'at');
    return {
      ok: true,
      type: 'issuable',
      at: new Date(at).toISOString(),
      batches: this.#fefoCandidates(at).map((b) => ({
        batch: b.id,
        qty: b.qty,
        expiry: new Date(b.expiry).toISOString(),
      })),
    };
  }

  #status() {
    return {
      ok: true,
      type: 'status',
      batches: [...this.batches.values()].map((b) => ({
        batch: b.id,
        qty: b.qty,
        state: b.state,
        expiry: new Date(b.expiry).toISOString(),
        inspection: b.inspection && {
          ...b.inspection,
          inspectedAt: new Date(b.inspection.inspectedAt).toISOString(),
          recordedAt: new Date(b.inspection.recordedAt).toISOString(),
        },
      })),
      issues: [...this.issues.values()].map((i) => ({
        issueId: i.id,
        orderId: i.orderId,
        at: new Date(i.at).toISOString(),
        undone: i.undone,
        allocations: i.allocations,
      })),
      certificates: this.certificates,
    };
  }
}
