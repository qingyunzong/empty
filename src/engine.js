import { createHash } from 'node:crypto';
import { inAnyInterval, coveredBy } from './intervals.js';

export class EngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}

function reqNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EngineError('BAD_FIELD', `field "${field}" must be a finite number`, { field });
  }
  return value;
}

function reqString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EngineError('BAD_FIELD', `field "${field}" must be a non-empty string`, { field });
  }
  return value;
}

function optNumber(value, field, fallback) {
  if (value === undefined) return fallback;
  return reqNumber(value, field);
}

function offsetAt(table, t) {
  const entry = table.offsets.find((e) => t >= e.start && t < e.end);
  if (!entry) {
    throw new EngineError('OFFSET_GAP', `offset table "${table.id}" has a gap at time ${t}`, {
      table: table.id,
      time: t,
    });
  }
  return entry.offset;
}

export class Engine {
  constructor() {
    this.devices = new Map(); // id -> { downtimes: [], lastEventTime }
    this.events = new Map(); // event id -> { id, device, time }
    this.rules = new Map(); // id -> rule
    this.shiftTables = new Map(); // id -> { id, offsets: [{start,end,offset}] }
    this.cutoff = null;
  }

  // Execute one JSON command; returns an array of output records (never throws
  // for domain errors — they are returned as {type:'error'} records).
  execute(cmd) {
    try {
      return this.#dispatch(cmd);
    } catch (err) {
      if (err instanceof EngineError) {
        return [{ type: 'error', error: err.code, message: err.message, ...err.details }];
      }
      throw err;
    }
  }

  #dispatch(cmd) {
    if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd)) {
      throw new EngineError('BAD_COMMAND', 'command must be a JSON object');
    }
    switch (cmd.cmd) {
      case 'shiftTable': return this.#addShiftTable(cmd);
      case 'rule': return this.#addRule(cmd);
      case 'heartbeat': return this.#addHeartbeat(cmd);
      case 'retract': return this.#retract(cmd);
      case 'override': return this.#override(cmd);
      case 'downtime': return this.#addDowntime(cmd);
      case 'cutoff': return this.#setCutoff(cmd);
      case 'scan': return this.#scan();
      default:
        throw new EngineError('UNKNOWN_COMMAND', `unknown command "${cmd.cmd}"`, { cmd: cmd.cmd });
    }
  }

  #device(id) {
    let dev = this.devices.get(id);
    if (!dev) {
      dev = { downtimes: [], lastEventTime: -Infinity };
      this.devices.set(id, dev);
    }
    return dev;
  }

  #addShiftTable(cmd) {
    const id = reqString(cmd.id, 'id');
    if (this.shiftTables.has(id)) {
      throw new EngineError('DUPLICATE_TABLE', `shift table "${id}" already exists`, { id });
    }
    if (!Array.isArray(cmd.offsets) || cmd.offsets.length === 0) {
      throw new EngineError('BAD_FIELD', 'field "offsets" must be a non-empty array', { field: 'offsets' });
    }
    const offsets = cmd.offsets.map((e, i) => {
      if (typeof e !== 'object' || e === null) {
        throw new EngineError('BAD_OFFSET_ENTRY', `offset entry ${i} must be an object`, { index: i });
      }
      const start = reqNumber(e.start, `offsets[${i}].start`);
      const end = reqNumber(e.end, `offsets[${i}].end`);
      const offset = reqNumber(e.offset, `offsets[${i}].offset`);
      if (!(start < end)) {
        throw new EngineError('BAD_OFFSET_ENTRY', `offset entry ${i} has start >= end`, { index: i });
      }
      return { start, end, offset };
    }).sort((a, b) => a.start - b.start);
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i - 1].end > offsets[i].start) {
        throw new EngineError('OFFSET_TABLE_OVERLAP', `offset entries ${i - 1} and ${i} overlap`, { index: i });
      }
    }
    this.shiftTables.set(id, { id, offsets });
    return [{ type: 'ack', cmd: 'shiftTable', id }];
  }

  #addRule(cmd) {
    const id = reqString(cmd.id, 'id');
    if (this.rules.has(id)) {
      throw new EngineError('DUPLICATE_RULE', `rule "${id}" already exists`, { id });
    }
    const device = reqString(cmd.device, 'device');
    const periodStart = reqNumber(cmd.periodStart, 'periodStart');
    const periodLength = reqNumber(cmd.periodLength, 'periodLength');
    if (periodLength <= 0) {
      throw new EngineError('ZERO_PERIOD', `rule "${id}" has non-positive period length`, { id });
    }
    const expectedOffset = optNumber(cmd.expectedOffset, 'expectedOffset', 0);
    const grace = optNumber(cmd.grace, 'grace', 0);
    const mergeGap = optNumber(cmd.mergeGap, 'mergeGap', 0);
    if (expectedOffset < 0 || grace < 0 || mergeGap < 0) {
      throw new EngineError('BAD_FIELD', 'expectedOffset, grace and mergeGap must be >= 0');
    }
    let shiftTable = null;
    if (cmd.shiftTable !== undefined) {
      shiftTable = reqString(cmd.shiftTable, 'shiftTable');
      if (!this.shiftTables.has(shiftTable)) {
        throw new EngineError('UNKNOWN_SHIFT_TABLE', `shift table "${shiftTable}" is not defined`, { id: shiftTable });
      }
    }
    this.rules.set(id, {
      id, device, periodStart, periodLength, expectedOffset, grace, mergeGap, shiftTable,
      version: 1,
    });
    return [{ type: 'ack', cmd: 'rule', id }];
  }

  #addHeartbeat(cmd) {
    const id = reqString(cmd.id, 'id');
    const device = reqString(cmd.device, 'device');
    const time = reqNumber(cmd.time, 'time');
    if (this.events.has(id)) {
      throw new EngineError('DUPLICATE_EVENT', `event "${id}" already exists`, { id });
    }
    const dev = this.#device(device);
    if (time < dev.lastEventTime) {
      throw new EngineError('TIME_INVERSION',
        `event "${id}" time ${time} is earlier than last event time ${dev.lastEventTime} on device "${device}"`,
        { id, device, time, lastEventTime: dev.lastEventTime });
    }
    this.events.set(id, { id, device, time });
    dev.lastEventTime = time;
    return [{ type: 'ack', cmd: 'heartbeat', id }];
  }

  #retract(cmd) {
    const id = reqString(cmd.id, 'id');
    const ev = this.events.get(id);
    if (!ev) {
      throw new EngineError('UNKNOWN_EVENT', `event "${id}" does not exist`, { id });
    }
    this.events.delete(id);
    return this.#correction('retract', ev);
  }

  #override(cmd) {
    const id = reqString(cmd.id, 'id');
    const time = reqNumber(cmd.time, 'time');
    const ev = this.events.get(id);
    if (!ev) {
      throw new EngineError('UNKNOWN_EVENT', `event "${id}" does not exist`, { id });
    }
    const dev = this.#device(ev.device);
    if (time < dev.lastEventTime) {
      throw new EngineError('TIME_INVERSION',
        `override of "${id}" to time ${time} is earlier than last event time ${dev.lastEventTime}`,
        { id, device: ev.device, time, lastEventTime: dev.lastEventTime });
    }
    ev.time = time;
    dev.lastEventTime = time;
    return this.#correction('override', ev);
  }

  #correction(kind, ev) {
    if (this.cutoff === null) {
      throw new EngineError('NO_CUTOFF', 'cutoff must be set before corrections can be evaluated');
    }
    const affected = [];
    for (const rule of this.rules.values()) {
      if (rule.device !== ev.device) continue;
      rule.version += 1;
      const { alarms, certificate } = this.#scanRule(rule);
      affected.push({ rule: rule.id, version: rule.version, certificate, alarms });
    }
    return [{ type: 'correction', kind, event: ev.id, affected }];
  }

  #addDowntime(cmd) {
    const device = reqString(cmd.device, 'device');
    const start = reqNumber(cmd.start, 'start');
    const end = reqNumber(cmd.end, 'end');
    if (!(start < end)) {
      throw new EngineError('BAD_INTERVAL', `downtime start ${start} must be < end ${end}`, { device });
    }
    this.#device(device).downtimes.push({ start, end });
    return [{ type: 'ack', cmd: 'downtime', device }];
  }

  #setCutoff(cmd) {
    const time = reqNumber(cmd.time, 'time');
    this.cutoff = time;
    return [{ type: 'ack', cmd: 'cutoff', time }];
  }

  #scan() {
    if (this.cutoff === null) {
      throw new EngineError('NO_CUTOFF', 'cutoff must be set before scanning');
    }
    const out = [];
    for (const rule of this.rules.values()) {
      const { alarms, certificate } = this.#scanRule(rule);
      out.push({ type: 'alarms', rule: rule.id, version: rule.version, certificate, alarms });
    }
    return out;
  }

  #scanRule(rule) {
    const dev = this.devices.get(rule.device) ?? { downtimes: [], events: undefined };
    const table = rule.shiftTable ? this.shiftTables.get(rule.shiftTable) : null;
    const cutoff = this.cutoff;

    // Enumerate judgeable periods: expected time must have arrived and the
    // full grace window must lie at or before the cutoff.
    const periods = [];
    const boundaries = [];
    for (let k = 0; ; k++) {
      const boundary = rule.periodStart + k * rule.periodLength;
      const base = boundary + rule.expectedOffset;
      if (base >= cutoff) break;
      const offset = table ? offsetAt(table, base) : 0;
      const start = base + offset;
      const end = start + rule.grace;
      if (end > cutoff) break;
      boundaries.push(boundary);
      periods.push({ k, start, end });
    }
    boundaries.push(rule.periodStart + periods.length * rule.periodLength);

    const heartbeats = [];
    for (const ev of this.events.values()) {
      if (ev.device === rule.device) heartbeats.push(ev.time);
    }
    heartbeats.sort((a, b) => a - b);

    // Build runs of consecutive missed periods. Exempt (fully covered by
    // downtime) and hit periods both close the current run.
    const alarms = [];
    let run = null;
    const closeRun = (open) => {
      if (!run) return;
      alarms.push({
        start: run.start,
        end: open ? cutoff : run.end,
        status: open ? 'OPEN' : 'CLOSED',
        missedPeriods: run.missed,
      });
      run = null;
    };
    for (const p of periods) {
      if (coveredBy(dev.downtimes, p.start, p.end)) {
        closeRun(false);
        continue;
      }
      const hit = heartbeats.some(
        (t) => t >= p.start && t <= p.end && !inAnyInterval(dev.downtimes, t),
      );
      if (hit) {
        closeRun(false);
        continue;
      }
      if (run) {
        run.end = p.end;
        run.missed.push(p.k);
      } else {
        run = { start: p.start, end: p.end, missed: [p.k] };
      }
    }
    closeRun(true);

    // Merge adjacent alarms of this rule when the gap is within mergeGap.
    const merged = [];
    for (const a of alarms) {
      const last = merged[merged.length - 1];
      if (last && a.start - last.end <= rule.mergeGap) {
        last.end = a.end;
        last.status = a.status;
        last.missedPeriods.push(...a.missedPeriods);
      } else {
        merged.push({ ...a });
      }
    }

    const certificate = {
      rule: rule.id,
      version: rule.version,
      from: rule.periodStart,
      to: cutoff,
      periodCount: periods.length,
      boundariesHash: createHash('sha256').update(JSON.stringify(boundaries)).digest('hex'),
    };
    return { alarms: merged, certificate };
  }
}
