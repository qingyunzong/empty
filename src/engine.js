'use strict';

const { EngineError } = require('./errors');
const { normalize, setOverlaps } = require('./intervals');
const {
  normalizeTimezones,
  validateRule,
  normalizeHolidays,
  isInWindow,
} = require('./windows');

const iso = (ms) => new Date(ms).toISOString();

function parseTime(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new EngineError('VALIDATION', `invalid time for ${field}`);
}

function parseInterval(value, field) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new EngineError('VALIDATION', `${field} must be a [start, end) pair`);
  }
  const s = parseTime(value[0], `${field}[0]`);
  const e = parseTime(value[1], `${field}[1]`);
  if (s > e) throw new EngineError('VALIDATION', `${field}: start must be <= end`);
  return [s, e];
}

function reqString(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new EngineError('VALIDATION', `${field} must be a non-empty string`);
  }
  return value;
}

const EVENT_TRANSITIONS = {
  available: { from: ['received'], to: 'available' },
  quarantine: { from: ['received', 'available'], to: 'quarantined' },
  release: { from: ['quarantined'], to: 'available' },
  scrap: { from: ['received', 'available', 'quarantined'], to: 'scrapped' },
};

class Engine {
  constructor() {
    this.config = { timezones: {}, rules: [], holidays: { cancel: [], add: [] } };
    this.batches = new Map();
    this.issues = new Map();
    this.certificates = [];
    this.seq = 0;
    this.certSeq = 0;
  }

  execute(cmd) {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.cmd !== 'string') {
      throw new EngineError('VALIDATION', 'command must be an object with a "cmd" string');
    }
    switch (cmd.cmd) {
      case 'configure': return this.configure(cmd);
      case 'receive': return this.receive(cmd);
      case 'event': return this.event(cmd);
      case 'inspect': return this.inspect(cmd);
      case 'issue': return this.issue(cmd);
      case 'undo': return this.undo(cmd);
      case 'restore': return this.restore(cmd);
      case 'snapshot': return this.snapshot();
      default: throw new EngineError('VALIDATION', `unknown command: ${cmd.cmd}`);
    }
  }

  configure(cmd) {
    const timezones = normalizeTimezones(cmd.timezones || {});
    const rules = (cmd.rules || []).map((r) => validateRule(r, timezones));
    const holidays = normalizeHolidays(cmd.holidays || {}, timezones);
    this.config = { timezones, rules, holidays };
    return { type: 'configure', rules: rules.length, timezones: Object.keys(timezones).length };
  }

  getBatch(id) {
    const batch = this.batches.get(id);
    if (!batch) throw new EngineError('UNKNOWN_BATCH', `unknown batch: ${id}`);
    return batch;
  }

  receive(cmd) {
    const id = reqString(cmd.batch, 'batch');
    if (this.batches.has(id)) {
      throw new EngineError('DUPLICATE_BATCH', `batch already exists: ${id}`);
    }
    if (typeof cmd.qty !== 'number' || !Number.isFinite(cmd.qty) || cmd.qty <= 0) {
      throw new EngineError('VALIDATION', 'qty must be a positive number');
    }
    const expiryMs = parseTime(cmd.expiry, 'expiry');
    const lotMs = parseInterval(cmd.lot, 'lot');
    const batch = {
      id,
      qty: cmd.qty,
      remaining: cmd.qty,
      expiryMs,
      lotMs,
      state: 'received',
      inspections: [],
    };
    this.batches.set(id, batch);
    return { type: 'receive', batch: id, qty: cmd.qty, state: 'received' };
  }

  event(cmd) {
    const batch = this.getBatch(reqString(cmd.batch, 'batch'));
    const type = reqString(cmd.type, 'type');
    const t = EVENT_TRANSITIONS[type];
    if (!t) throw new EngineError('VALIDATION', `unknown event type: ${type}`);
    if (!t.from.includes(batch.state)) {
      throw new EngineError('INVALID_STATE', `cannot apply ${type} to batch ${batch.id} in state ${batch.state}`);
    }
    batch.state = t.to;
    if (type === 'scrap') batch.remaining = 0;
    return { type: 'event', batch: batch.id, event: type, state: batch.state };
  }

  effectiveInspection(batch) {
    let best = null;
    for (const insp of batch.inspections) {
      if (!best
          || insp.recordedAtMs > best.recordedAtMs
          || (insp.recordedAtMs === best.recordedAtMs && insp.seq > best.seq)) {
        best = insp;
      }
    }
    return best;
  }

  // Qualification: batch state plus effective inspection outcome, independent
  // of how much stock remains (a fully consumed batch can still lose its
  // qualification through a late correction).
  isQualified(batch) {
    if (batch.state !== 'available') return false;
    const insp = this.effectiveInspection(batch);
    return Boolean(insp && insp.inWindow && !insp.defectHit);
  }

  isIssuable(batch) {
    return this.isQualified(batch) && batch.remaining > 0;
  }

  issuableTotal() {
    let total = 0;
    for (const b of this.batches.values()) {
      if (this.isIssuable(b)) total += b.remaining;
    }
    return total;
  }

  inspect(cmd) {
    const batch = this.getBatch(reqString(cmd.batch, 'batch'));
    const timeMs = parseTime(cmd.time, 'time');
    const recordedAtMs = cmd.recordedAt === undefined ? timeMs : parseTime(cmd.recordedAt, 'recordedAt');
    const defects = (cmd.defects || []).map((d, i) => parseInterval(d, `defects[${i}]`));
    const inWindow = isInWindow(this.config, timeMs);
    const defectHit = setOverlaps(normalize(defects), batch.lotMs);

    const issuableTotalBefore = this.issuableTotal();
    const wasQualified = this.isQualified(batch);
    batch.inspections.push({ seq: this.seq++, timeMs, recordedAtMs, defects, inWindow, defectHit });
    const nowQualified = this.isQualified(batch);
    const issuableTotalAfter = this.issuableTotal();

    // Late correction: the record revokes issuability that historical issues
    // relied on. Issued stock is NOT recalled; downstream certificates are
    // generated for every affected applied issue at/after the inspection time.
    const affected = [];
    if (wasQualified && !nowQualified) {
      for (const issue of this.issues.values()) {
        if (issue.status !== 'applied' || issue.timeMs < timeMs) continue;
        for (const alloc of issue.allocations) {
          if (alloc.batch !== batch.id || alloc.qty <= 0) continue;
          const cert = {
            id: `CERT-${String(++this.certSeq).padStart(4, '0')}`,
            type: 'affected-downstream-certificate',
            issue: issue.id,
            batch: batch.id,
            qty: alloc.qty,
            issueTime: iso(issue.timeMs),
            inspectionTime: iso(timeMs),
            recordedAt: iso(recordedAtMs),
            reason: 'late-inspection-revoked-issuability',
          };
          this.certificates.push(cert);
          affected.push(cert);
        }
      }
    }

    return {
      type: 'inspect',
      batch: batch.id,
      inWindow,
      defectHit,
      issuable: nowQualified,
      recompute: {
        asOf: iso(timeMs),
        previouslyIssuable: wasQualified,
        issuable: nowQualified,
        issuableTotalBefore,
        issuableTotalAfter,
        affectedCertificates: affected,
      },
    };
  }

  issue(cmd) {
    const id = reqString(cmd.id, 'id');
    if (this.issues.has(id)) throw new EngineError('DUPLICATE_ISSUE', `issue already exists: ${id}`);
    if (typeof cmd.qty !== 'number' || !Number.isFinite(cmd.qty) || cmd.qty <= 0) {
      throw new EngineError('VALIDATION', 'qty must be a positive number');
    }
    const timeMs = parseTime(cmd.time, 'time');
    // FEFO: earliest expiry first; ties on the same expiry instant by batch id.
    const candidates = [...this.batches.values()]
      .filter((b) => this.isIssuable(b))
      .sort((a, b) => a.expiryMs - b.expiryMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let need = cmd.qty;
    const allocations = [];
    for (const c of candidates) {
      if (need <= 0) break;
      const take = Math.min(need, c.remaining);
      if (take > 0) {
        c.remaining -= take;
        allocations.push({ batch: c.id, qty: take });
        need -= take;
      }
    }
    if (need > 0) {
      for (const a of allocations) this.batches.get(a.batch).remaining += a.qty;
      throw new EngineError('NEGATIVE_INVENTORY',
        `insufficient issuable stock for issue ${id}: short ${need} of ${cmd.qty}`);
    }
    this.issues.set(id, { id, qty: cmd.qty, timeMs, allocations, status: 'applied' });
    return { type: 'issue', id, qty: cmd.qty, allocations, status: 'applied' };
  }

  undo(cmd) {
    const id = reqString(cmd.issue, 'issue');
    const issue = this.issues.get(id);
    if (!issue) throw new EngineError('UNKNOWN_ISSUE', `unknown issue: ${id}`);
    if (issue.status !== 'applied') {
      throw new EngineError('INVALID_STATE', `issue ${id} is ${issue.status}, cannot undo`);
    }
    for (const a of issue.allocations) this.batches.get(a.batch).remaining += a.qty;
    issue.status = 'undone';
    return { type: 'undo', issue: id, status: 'undone' };
  }

  restore(cmd) {
    const id = reqString(cmd.issue, 'issue');
    const issue = this.issues.get(id);
    if (!issue) throw new EngineError('UNKNOWN_ISSUE', `unknown issue: ${id}`);
    if (issue.status !== 'undone') {
      throw new EngineError('INVALID_STATE', `issue ${id} is ${issue.status}, cannot restore`);
    }
    for (const a of issue.allocations) {
      if (this.batches.get(a.batch).remaining < a.qty) {
        throw new EngineError('NEGATIVE_INVENTORY',
          `restore of issue ${id} would drive batch ${a.batch} negative`);
      }
    }
    for (const a of issue.allocations) this.batches.get(a.batch).remaining -= a.qty;
    issue.status = 'applied';
    return { type: 'restore', issue: id, status: 'applied' };
  }

  snapshot() {
    return {
      type: 'snapshot',
      issuableTotal: this.issuableTotal(),
      batches: [...this.batches.values()].map((b) => ({
        id: b.id,
        state: b.state,
        qty: b.qty,
        remaining: b.remaining,
        expiry: iso(b.expiryMs),
        issuable: this.isIssuable(b),
      })),
      issues: [...this.issues.values()].map((i) => ({
        id: i.id,
        qty: i.qty,
        time: iso(i.timeMs),
        status: i.status,
        allocations: i.allocations,
      })),
      certificates: this.certificates,
    };
  }
}

module.exports = { Engine, EngineError };
