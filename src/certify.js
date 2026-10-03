import { TraceError } from './errors.js';

export const DEFAULTS = Object.freeze({
  windowMs: 500,
  watermarkLagMs: 1000,
  angleMin: 0,
  angleMax: 720,
});

function laterEvent(a, b) {
  if (a.eventTs !== b.eventTs) return a.eventTs > b.eventTs ? a : b;
  return a.id >= b.id ? a : b;
}

function canonical(event) {
  const { seq, ...rest } = event;
  return JSON.stringify(rest);
}

function certKey(cert) {
  return JSON.stringify(cert);
}

function mapValues(map) {
  return map ? [...map.values()] : [];
}

export class Certifier {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.eventsById = new Map();
    this.retractedIds = new Set();
    this.torquesByBolt = new Map();
    this.scansByBolt = new Map();
    this.calibsByTool = new Map();
    this.boltsByTool = new Map();
    this.lastEmitted = new Map();
    this.versionByBolt = new Map();
    this.emissions = [];
    this.late = [];
    this.reports = [];
    this.maxEventTs = null;
    this.watermark = null;
    this.seq = 0;
  }

  ingest(event) {
    if (event.kind !== 'retract') {
      const existing = this.eventsById.get(event.id);
      if (existing) {
        if (canonical(existing) === canonical(event)) return { duplicate: true, late: false };
        throw new TraceError(
          'DUP_EVENT',
          `conflicting events share id "${event.id}"`,
          { id: event.id },
        );
      }
    }

    this.seq += 1;
    const ev = { ...event, seq: this.seq };
    if (ev.kind !== 'retract') this.eventsById.set(ev.id, ev);

    if (this.maxEventTs === null || ev.eventTs > this.maxEventTs) {
      this.maxEventTs = ev.eventTs;
      this.watermark = this.maxEventTs - this.opts.watermarkLagMs;
    }
    const late = this.watermark !== null && ev.eventTs < this.watermark;
    if (late) {
      this.late.push({
        seq: ev.seq,
        id: ev.id,
        kind: ev.kind,
        eventTs: ev.eventTs,
        watermark: this.watermark,
        reason: 'LATE_EVENT',
      });
    }

    const affected = new Set();
    switch (ev.kind) {
      case 'torque': {
        if (ev.angle < this.opts.angleMin || ev.angle > this.opts.angleMax) {
          this.reports.push({
            code: 'ANGLE_RANGE',
            id: ev.id,
            bolt: ev.bolt,
            angle: ev.angle,
            angleMin: this.opts.angleMin,
            angleMax: this.opts.angleMax,
          });
        }
        this.#index(this.torquesByBolt, ev.bolt, ev);
        this.#index(this.boltsByTool, ev.tool, ev.bolt, true);
        affected.add(ev.bolt);
        break;
      }
      case 'scan':
        this.#index(this.scansByBolt, ev.bolt, ev);
        affected.add(ev.bolt);
        break;
      case 'calib':
        this.#index(this.calibsByTool, ev.tool, ev);
        for (const bolt of this.boltsByTool.get(ev.tool) ?? []) affected.add(bolt);
        break;
      case 'retract': {
        this.retractedIds.add(ev.targetId);
        const target = this.eventsById.get(ev.targetId);
        if (target) {
          if (target.kind === 'torque' || target.kind === 'scan') affected.add(target.bolt);
          else if (target.kind === 'calib') {
            for (const bolt of this.boltsByTool.get(target.tool) ?? []) affected.add(bolt);
          }
        }
        break;
      }
      default:
        throw new TraceError('BAD_EVENT', `unsupported kind "${ev.kind}"`);
    }

    for (const bolt of affected) this.#reevaluate(bolt);
    return { duplicate: false, late };
  }

  #index(index, key, value, isSet = false) {
    let bucket = index.get(key);
    if (!bucket) {
      bucket = isSet ? new Set() : new Map();
      index.set(key, bucket);
    }
    if (isSet) bucket.add(value);
    else bucket.set(value.id, value);
  }

  #isActive(ev) {
    return !this.retractedIds.has(ev.id);
  }

  evaluateBolt(bolt) {
    const { angleMin, angleMax, windowMs } = this.opts;
    const torques = mapValues(this.torquesByBolt.get(bolt)).filter((t) => this.#isActive(t));
    const qualified = torques.filter((t) => t.angle >= angleMin && t.angle <= angleMax);
    if (qualified.length === 0) return null;

    const winner = qualified.reduce(laterEvent);
    const lo = winner.eventTs - windowMs;
    const hi = winner.eventTs + windowMs;
    const overlaps = (c) => c.validFrom <= hi && c.validTo >= lo;

    const calibs = mapValues(this.calibsByTool.get(winner.tool));
    const validCalibs = calibs.filter((c) => this.#isActive(c) && c.ok === true && overlaps(c));
    const calib = validCalibs.length > 0 ? validCalibs.reduce(laterEvent) : null;
    const retractedApplicable = calibs.some(
      (c) => !this.#isActive(c) && c.ok === true && overlaps(c),
    );

    const scans = mapValues(this.scansByBolt.get(bolt)).filter(
      (s) => this.#isActive(s) && Math.abs(s.eventTs - winner.eventTs) <= windowMs,
    );
    const scan = scans.length > 0 ? scans.reduce(laterEvent) : null;

    const reasons = [];
    if (!calib) reasons.push(retractedApplicable ? 'CALIB_RETRACTED' : 'NO_CALIB');
    if (!scan) reasons.push('MISSING_LOT');

    let status = 'OK';
    if (reasons.includes('CALIB_RETRACTED')) status = 'VOID';
    else if (reasons.length > 0) status = 'HOLD';

    return {
      bolt,
      status,
      reasons,
      torqueId: winner.id,
      tool: winner.tool,
      eventTs: winner.eventTs,
      peak: winner.peak,
      angle: winner.angle,
      op: winner.op ?? null,
      calibId: calib ? calib.id : null,
      lot: scan ? scan.lot : null,
    };
  }

  #voidForMissingTorque(bolt) {
    const { angleMin, angleMax } = this.opts;
    const retractedQualified = mapValues(this.torquesByBolt.get(bolt)).some(
      (t) => !this.#isActive(t) && t.angle >= angleMin && t.angle <= angleMax,
    );
    return {
      bolt,
      status: 'VOID',
      reasons: [retractedQualified ? 'TORQUE_RETRACTED' : 'NO_VALID_TORQUE'],
      torqueId: null,
      tool: null,
      eventTs: null,
      peak: null,
      angle: null,
      op: null,
      calibId: null,
      lot: null,
    };
  }

  #reevaluate(bolt) {
    const cert = this.evaluateBolt(bolt) ?? this.#voidForMissingTorque(bolt);
    const prev = this.lastEmitted.get(bolt);
    if (!cert) return;
    if (!prev && cert.status === 'VOID' && cert.torqueId === null) return;
    if (prev && certKey(prev) === certKey({ ...cert })) return;

    const version = (this.versionByBolt.get(bolt) ?? 0) + 1;
    this.versionByBolt.set(bolt, version);
    const record = { ...cert, version, seq: this.seq };
    this.lastEmitted.set(bolt, { ...cert });
    this.emissions.push({ stream: record.status === 'VOID' ? 'void' : 'certs', record });
  }

  finalCerts() {
    const out = new Map();
    for (const { record } of this.emissions) out.set(record.bolt, record);
    return out;
  }

  summary() {
    return {
      events: this.seq,
      emissions: this.emissions.length,
      certs: this.emissions.filter((e) => e.stream === 'certs').length,
      voids: this.emissions.filter((e) => e.stream === 'void').length,
      late: this.late.length,
      reports: this.reports.length,
      watermark: this.watermark,
    };
  }
}
