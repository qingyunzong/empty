'use strict';

const crypto = require('node:crypto');

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

function requireFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EngineError('BAD_INPUT', `${field} must be a finite number, got ${JSON.stringify(value)}`);
  }
}

class Engine {
  constructor() {
    this.rules = new Map();
    this.shiftTable = [];
    this.downtime = [];
    this.heartbeats = new Map();
    this.mergeGapMs = 0;
    this.cutoffMs = null;
    this.lastEventAt = null;
    this.versions = new Map();
  }

  setMergeGap(ms) {
    requireFiniteNumber(ms, 'mergeGapMs');
    if (ms < 0) throw new EngineError('BAD_INPUT', 'mergeGapMs must be >= 0');
    this.mergeGapMs = ms;
  }

  setShiftTable(table) {
    if (!Array.isArray(table)) throw new EngineError('BAD_INPUT', 'shift table must be an array');
    const segments = table.map((seg, i) => {
      requireFiniteNumber(seg.start, `table[${i}].start`);
      requireFiniteNumber(seg.end, `table[${i}].end`);
      requireFiniteNumber(seg.offsetMs, `table[${i}].offsetMs`);
      if (seg.start >= seg.end) throw new EngineError('BAD_INPUT', `table[${i}] has start >= end`);
      return { start: seg.start, end: seg.end, offsetMs: seg.offsetMs };
    });
    segments.sort((a, b) => a.start - b.start);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].start < segments[i - 1].end) {
        throw new EngineError('SHIFT_OVERLAP', `shift segments ${i - 1} and ${i} overlap`);
      }
    }
    this.shiftTable = segments;
  }

  setDowntime(intervals) {
    if (!Array.isArray(intervals)) throw new EngineError('BAD_INPUT', 'downtime must be an array');
    const sorted = intervals.map((iv, i) => {
      requireFiniteNumber(iv.start, `intervals[${i}].start`);
      requireFiniteNumber(iv.end, `intervals[${i}].end`);
      if (iv.start >= iv.end) throw new EngineError('BAD_INPUT', `intervals[${i}] has start >= end`);
      return { start: iv.start, end: iv.end };
    }).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const iv of sorted) {
      const last = merged[merged.length - 1];
      if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
      else merged.push({ ...iv });
    }
    this.downtime = merged;
  }

  addRule(rule) {
    if (!rule || typeof rule.id !== 'string' || rule.id.length === 0) {
      throw new EngineError('BAD_INPUT', 'rule.id must be a non-empty string');
    }
    requireFiniteNumber(rule.epochStartMs, 'rule.epochStartMs');
    requireFiniteNumber(rule.periodMs, 'rule.periodMs');
    if (rule.periodMs <= 0) {
      throw new EngineError('PERIOD_ZERO', `rule ${rule.id}: periodMs must be > 0`);
    }
    if (!Array.isArray(rule.expectedOffsetsMs) || rule.expectedOffsetsMs.length === 0) {
      throw new EngineError('BAD_INPUT', `rule ${rule.id}: expectedOffsetsMs must be a non-empty array`);
    }
    const expected = rule.expectedOffsetsMs.map((off, i) => {
      requireFiniteNumber(off, `expectedOffsetsMs[${i}]`);
      if (off < 0 || off >= rule.periodMs) {
        throw new EngineError('BAD_INPUT', `rule ${rule.id}: expected offset ${off} outside [0, periodMs)`);
      }
      return off;
    }).sort((a, b) => a - b);
    requireFiniteNumber(rule.graceMs, 'rule.graceMs');
    if (rule.graceMs < 0) throw new EngineError('BAD_INPUT', `rule ${rule.id}: graceMs must be >= 0`);
    this.rules.set(rule.id, {
      id: rule.id,
      epochStartMs: rule.epochStartMs,
      periodMs: rule.periodMs,
      expectedOffsetsMs: expected,
      graceMs: rule.graceMs,
    });
    if (!this.versions.has(rule.id)) this.versions.set(rule.id, 0);
  }

  setCutoff(time) {
    requireFiniteNumber(time, 'cutoff time');
    this.cutoffMs = time;
  }

  offsetAt(t) {
    for (const seg of this.shiftTable) {
      if (t >= seg.start && t < seg.end) return seg.offsetMs;
    }
    throw new EngineError('OFFSET_GAP', `offset table gap at t=${t}`);
  }

  inDowntime(t) {
    for (const iv of this.downtime) {
      if (t >= iv.start && t < iv.end) return true;
    }
    return false;
  }

  frontier() {
    if (this.cutoffMs !== null) return this.cutoffMs;
    if (this.lastEventAt !== null) return this.lastEventAt;
    return 0;
  }

  periodCount(rule, upto) {
    if (upto < rule.epochStartMs) return 0;
    return Math.floor((upto - rule.epochStartMs) / rule.periodMs) + 1;
  }

  periodStart(rule, k) {
    const nominal = rule.epochStartMs + k * rule.periodMs;
    return nominal + this.offsetAt(nominal);
  }

  periodBoundaries(ruleId, upto) {
    const rule = this.rules.get(ruleId);
    if (!rule) throw new EngineError('NO_RULE', `unknown rule ${ruleId}`);
    const limit = upto === undefined ? this.frontier() : upto;
    const n = this.periodCount(rule, limit);
    const boundaries = [];
    for (let k = 0; k < n; k++) boundaries.push(this.periodStart(rule, k));
    if (n > 0) boundaries.push(this.periodStart(rule, n - 1) + rule.periodMs);
    return boundaries;
  }

  hasCoveringHeartbeat(from, to) {
    for (const t of this.heartbeats.values()) {
      if (t >= from && t <= to && !this.inDowntime(t)) return true;
    }
    return false;
  }

  periodStatus(rule, k, cutoff) {
    const start = this.periodStart(rule, k);
    let violated = false;
    let pending = false;
    let anyJudged = false;
    for (const off of rule.expectedOffsetsMs) {
      const e = start + off;
      if (e >= cutoff) continue;
      if (this.inDowntime(e)) continue;
      anyJudged = true;
      if (this.hasCoveringHeartbeat(e, e + rule.graceMs)) continue;
      if (e + rule.graceMs > cutoff) pending = true;
      else violated = true;
    }
    if (violated) return 'silent';
    if (pending) return 'pending';
    if (anyJudged) return 'ok';
    return 'neutral';
  }

  scanRule(rule, cutoff) {
    const n = this.periodCount(rule, cutoff);
    const periods = [];
    for (let k = 0; k < n; k++) {
      const start = this.periodStart(rule, k);
      periods.push({ k, start, end: start + rule.periodMs, status: this.periodStatus(rule, k, cutoff) });
    }
    const raw = [];
    let cur = null;
    for (const p of periods) {
      const bad = p.status === 'silent' || p.status === 'pending';
      if (bad) {
        if (!cur) cur = { fromPeriod: p.k, toPeriod: p.k, start: p.start, end: p.end };
        else { cur.toPeriod = p.k; cur.end = p.end; }
      } else if (cur) {
        raw.push(cur);
        cur = null;
      }
    }
    if (cur) raw.push(cur);
    const lastK = n - 1;
    for (const a of raw) a.open = a.toPeriod === lastK;
    const merged = [];
    for (const a of raw) {
      const prev = merged[merged.length - 1];
      if (prev && !prev.open && a.start - prev.end <= this.mergeGapMs) {
        prev.toPeriod = a.toPeriod;
        prev.end = a.end;
        prev.open = a.open;
      } else {
        merged.push({ ...a });
      }
    }
    return { periods, alarms: merged };
  }

  alarms() {
    const cutoff = this.frontier();
    const out = [];
    for (const rule of this.rules.values()) {
      for (const a of this.scanRule(rule, cutoff).alarms) {
        out.push({
          ruleId: rule.id,
          fromPeriod: a.fromPeriod,
          toPeriod: a.toPeriod,
          start: a.start,
          end: a.open ? null : a.end,
          status: a.open ? 'OPEN' : 'CLOSED',
        });
      }
    }
    out.sort((x, y) => x.start - y.start || (x.ruleId < y.ruleId ? -1 : x.ruleId > y.ruleId ? 1 : 0));
    return out;
  }

  certificate(rule, version, eventId, frontier) {
    const boundaries = this.periodBoundaries(rule.id, frontier);
    const payload = {
      ruleId: rule.id,
      version,
      eventId,
      cutoffMs: frontier,
      boundaries,
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    return { ...payload, digest };
  }

  applyEvent(ev) {
    if (!ev || typeof ev.id !== 'string' || ev.id.length === 0) {
      throw new EngineError('BAD_EVENT', 'event.id must be a non-empty string');
    }
    const at = ev.at !== undefined ? ev.at : ev.time;
    requireFiniteNumber(at, 'event.at');
    if (this.lastEventAt !== null && at < this.lastEventAt) {
      throw new EngineError('TIME_INVERSION', `event time ${at} is before previous event time ${this.lastEventAt}`);
    }
    this.lastEventAt = at;
    const affected = [];
    if (ev.kind === 'append') {
      requireFiniteNumber(ev.time, 'event.time');
      if (this.heartbeats.has(ev.id)) throw new EngineError('DUP_EVENT', `heartbeat ${ev.id} already exists`);
      this.heartbeats.set(ev.id, ev.time);
      affected.push(ev.time);
    } else if (ev.kind === 'retract') {
      if (!this.heartbeats.has(ev.id)) throw new EngineError('NO_EVENT', `heartbeat ${ev.id} does not exist`);
      affected.push(this.heartbeats.get(ev.id));
      this.heartbeats.delete(ev.id);
    } else if (ev.kind === 'override') {
      requireFiniteNumber(ev.time, 'event.time');
      if (!this.heartbeats.has(ev.id)) throw new EngineError('NO_EVENT', `heartbeat ${ev.id} does not exist`);
      affected.push(this.heartbeats.get(ev.id));
      this.heartbeats.set(ev.id, ev.time);
      affected.push(ev.time);
    } else {
      throw new EngineError('BAD_KIND', `unknown event kind ${JSON.stringify(ev.kind)}`);
    }
    const frontier = this.cutoffMs !== null ? this.cutoffMs : at;
    const corrections = [];
    for (const rule of this.rules.values()) {
      const hit = affected.some((t) => t >= rule.epochStartMs && t <= frontier);
      if (!hit) continue;
      const version = (this.versions.get(rule.id) || 0) + 1;
      this.versions.set(rule.id, version);
      corrections.push({
        type: 'correction',
        ruleId: rule.id,
        version,
        certificate: this.certificate(rule, version, ev.id, frontier),
      });
    }
    return corrections;
  }
}

module.exports = { Engine, EngineError };
