export const DEFAULTS = Object.freeze({
  windowMs: 500,
  latenessMs: 0,
  angleMin: 0,
  angleMax: 360,
});

const KINDS = new Set(['torque', 'calib', 'scan']);

export function compareIds(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

// "Last" event: greatest eventTs, ties broken by greatest id (numeric-aware).
export function pickLast(events) {
  let best = null;
  for (const e of events) {
    if (
      !best ||
      e.eventTs > best.eventTs ||
      (e.eventTs === best.eventTs && compareIds(e.id, best.id) > 0)
    ) {
      best = e;
    }
  }
  return best;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function isStr(x) {
  return typeof x === 'string' && x.length > 0;
}

function invalid(message) {
  return { error: message };
}

export function validate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('event must be a JSON object');
  }
  const type = raw.type;
  if (type === 'retract') {
    if (!isNum(raw.eventTs)) return invalid('retract.eventTs must be a finite number');
    if (!KINDS.has(raw.kind)) return invalid('retract.kind must be torque|calib|scan');
    if (!isStr(raw.id)) return invalid('retract.id (target) must be a non-empty string');
    return { event: { type, eventTs: raw.eventTs, kind: raw.kind, id: raw.id } };
  }
  if (!KINDS.has(type)) return invalid(`unknown event type: ${String(type)}`);
  if (!isStr(raw.id)) return invalid(`${type}.id must be a non-empty string`);
  if (!isNum(raw.eventTs)) return invalid(`${type}.eventTs must be a finite number`);
  const base = { type, id: raw.id, eventTs: raw.eventTs, op: raw.op ?? null };
  if (type === 'torque') {
    if (!isStr(raw.bolt) || !isStr(raw.tool)) return invalid('torque requires bolt and tool strings');
    if (!isNum(raw.peak) || !isNum(raw.angle)) return invalid('torque requires numeric peak and angle');
    return { event: { ...base, bolt: raw.bolt, tool: raw.tool, peak: raw.peak, angle: raw.angle } };
  }
  if (type === 'calib') {
    if (!isStr(raw.tool)) return invalid('calib requires a tool string');
    if (typeof raw.ok !== 'boolean') return invalid('calib.ok must be a boolean');
    if (!isNum(raw.validFrom) || !isNum(raw.validTo) || raw.validFrom > raw.validTo) {
      return invalid('calib requires validFrom <= validTo (finite numbers)');
    }
    return { event: { ...base, tool: raw.tool, ok: raw.ok, validFrom: raw.validFrom, validTo: raw.validTo } };
  }
  if (!isStr(raw.bolt) || !isStr(raw.lot)) return invalid('scan requires bolt and lot strings');
  return { event: { ...base, bolt: raw.bolt, lot: raw.lot } };
}

function addTo(index, key, id) {
  let set = index.get(key);
  if (!set) {
    set = new Set();
    index.set(key, set);
  }
  set.add(id);
}

function sameCert(a, b) {
  return (
    a.status === b.status &&
    a.reason === b.reason &&
    a.torqueId === b.torqueId &&
    a.calibId === b.calibId &&
    a.scanId === b.scanId &&
    a.lot === b.lot
  );
}

export class Engine {
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    this.events = new Map(); // id -> { event, raw }
    this.retracted = new Set();
    this.boltTorques = new Map(); // bolt -> Set<id>
    this.boltScans = new Map(); // bolt -> Set<id>
    this.toolCalibs = new Map(); // tool -> Set<id>
    this.certs = new Map(); // bolt -> [cert versions]
    this.certLog = []; // every cert version, append-only
    this.voids = []; // OK -> VOID transitions
    this.late = []; // events behind the watermark
    this.errors = []; // DUP_EVENT, ANGLE_RANGE, INVALID_EVENT, ...
    this.maxTs = -Infinity;
    this.seq = 0;
  }

  watermark() {
    return this.maxTs === -Infinity ? -Infinity : this.maxTs - this.cfg.latenessMs;
  }

  apply(raw, source = {}) {
    const { event, error } = validate(raw);
    if (error) {
      this.errors.push({ code: 'INVALID_EVENT', message: error, ...source });
      return null;
    }
    const wm = this.watermark();
    if (event.eventTs < wm) {
      this.late.push({
        id: event.type === 'retract' ? null : event.id,
        type: event.type,
        eventTs: event.eventTs,
        watermark: wm,
        ...source,
      });
    }
    if (event.eventTs > this.maxTs) this.maxTs = event.eventTs;
    if (event.type === 'retract') return this.applyRetract(event, source);

    const existing = this.events.get(event.id);
    if (existing) {
      if (existing.raw === stableStringify(raw)) return existing.event; // idempotent replay
      this.errors.push({
        code: 'DUP_EVENT',
        id: event.id,
        message: `conflicting payloads for event id "${event.id}"; first occurrence kept`,
        ...source,
      });
      return null;
    }

    if (
      event.type === 'torque' &&
      (event.angle < this.cfg.angleMin || event.angle > this.cfg.angleMax)
    ) {
      this.errors.push({
        code: 'ANGLE_RANGE',
        id: event.id,
        angle: event.angle,
        message: `angle ${event.angle} outside [${this.cfg.angleMin}, ${this.cfg.angleMax}]; event disqualified`,
        ...source,
      });
    }

    this.events.set(event.id, { event, raw: stableStringify(raw) });
    if (event.type === 'torque') {
      addTo(this.boltTorques, event.bolt, event.id);
      this.rejudge(event.bolt);
    } else if (event.type === 'scan') {
      addTo(this.boltScans, event.bolt, event.id);
      this.rejudge(event.bolt);
    } else {
      addTo(this.toolCalibs, event.tool, event.id);
      this.rejudgeAll();
    }
    return event;
  }

  applyRetract(event, source) {
    const rec = this.events.get(event.id);
    if (!rec) {
      this.errors.push({
        code: 'UNKNOWN_RETRACT',
        id: event.id,
        message: `retract targets unknown event id "${event.id}"`,
        ...source,
      });
      return null;
    }
    if (this.retracted.has(event.id)) return null; // already retracted
    if (rec.event.type !== event.kind) {
      this.errors.push({
        code: 'KIND_MISMATCH',
        id: event.id,
        message: `retract kind "${event.kind}" does not match stored type "${rec.event.type}"`,
        ...source,
      });
      return null;
    }
    this.retracted.add(event.id);
    if (event.kind === 'calib') this.rejudgeAll();
    else this.rejudge(rec.event.bolt);
    return event;
  }

  rejudgeAll() {
    for (const bolt of this.boltTorques.keys()) this.rejudge(bolt);
  }

  rejudge(bolt) {
    const versions = this.certs.get(bolt) ?? [];
    const prev = versions.length ? versions[versions.length - 1] : null;
    const next = this.computeCert(bolt, prev);
    if (!next) return; // no qualified tightening -> nothing to certify
    if (prev && sameCert(prev, next)) return;
    next.version = (prev ? prev.version : 0) + 1;
    next.seq = ++this.seq;
    versions.push(next);
    this.certs.set(bolt, versions);
    this.certLog.push(next);
    if (next.status === 'VOID' && prev && prev.status === 'OK') {
      this.voids.push({
        bolt,
        voidedVersion: prev.version,
        version: next.version,
        reason: next.reason,
        torqueId: next.torqueId,
        calibId: prev.calibId,
        seq: next.seq,
      });
    }
  }

  computeCert(bolt, prev) {
    const { angleMin, angleMax, windowMs } = this.cfg;
    const live = (id) => !this.retracted.has(id);
    const get = (id) => this.events.get(id).event;

    const qualified = [...(this.boltTorques.get(bolt) ?? [])]
      .filter(live)
      .map(get)
      .filter((e) => e.angle >= angleMin && e.angle <= angleMax);
    if (!qualified.length) return null;
    const eff = pickLast(qualified);

    const calib = pickLast(
      [...(this.toolCalibs.get(eff.tool) ?? [])]
        .filter(live)
        .map(get)
        .filter((c) => c.ok && c.validFrom <= eff.eventTs && eff.eventTs <= c.validTo),
    );
    const scan = pickLast(
      [...(this.boltScans.get(bolt) ?? [])]
        .filter(live)
        .map(get)
        .filter((s) => Math.abs(s.eventTs - eff.eventTs) <= windowMs),
    );

    let status;
    let reason = null;
    if (!calib) {
      status = 'HOLD';
      reason = 'NO_CALIB';
    } else if (!scan) {
      status = 'HOLD';
      reason = 'NO_LOT';
    } else {
      status = 'OK';
    }
    // An issued OK cert is never silently downgraded or deleted: it becomes VOID
    // (sticky until a later re-judgement can certify OK again).
    if (status !== 'OK' && prev && (prev.status === 'OK' || prev.status === 'VOID')) {
      status = 'VOID';
    }
    return {
      bolt,
      status,
      reason,
      torqueId: eff.id,
      tool: eff.tool,
      peak: eff.peak,
      angle: eff.angle,
      eventTs: eff.eventTs,
      calibId: calib ? calib.id : null,
      scanId: scan ? scan.id : null,
      lot: scan ? scan.lot : null,
    };
  }

  finalCerts() {
    const out = new Map();
    for (const [bolt, versions] of this.certs) out.set(bolt, versions[versions.length - 1]);
    return out;
  }
}
