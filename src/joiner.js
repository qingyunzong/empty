'use strict';

const WINDOW_MS = 5 * 60 * 1000;

const EVENT_TYPES = new Set(['SAMPLE_ACQUIRED', 'QC_RESULT']);
const OPS = new Set(['UPSERT', 'RETRACT']);

class JoinError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'JoinError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function malformed(message, details) {
  return new JoinError('MALFORMED', message, details);
}

function windowStartOf(eventTime) {
  return Math.floor(eventTime / WINDOW_MS) * WINDOW_MS;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Validates a parsed JSON value. Returns the record unchanged when valid,
// throws JoinError(MALFORMED) otherwise.
function validateRecord(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw malformed('record must be a JSON object');
  }
  if (raw.type === 'EVENT') {
    if (!EVENT_TYPES.has(raw.event)) {
      throw malformed(`event must be one of ${[...EVENT_TYPES].join(', ')}`, { event: raw.event });
    }
    if (!OPS.has(raw.op)) {
      throw malformed('op must be UPSERT or RETRACT', { op: raw.op });
    }
    if (typeof raw.sampleId !== 'string' || raw.sampleId.length === 0) {
      throw malformed('sampleId must be a non-empty string');
    }
    if (!isFiniteNumber(raw.eventTime) || raw.eventTime < 0) {
      throw malformed('eventTime must be a finite number >= 0', { eventTime: raw.eventTime });
    }
    return raw;
  }
  if (raw.type === 'WATERMARK') {
    if (!isFiniteNumber(raw.time) || raw.time < 0) {
      throw malformed('watermark time must be a finite number >= 0', { time: raw.time });
    }
    return raw;
  }
  throw malformed(`unknown record type: ${String(raw.type)}`, { type: raw.type });
}

class Joiner {
  constructor() {
    // windowStart -> { sample: Map<sampleId, event>, qc: Map<sampleId, event>, joined: Set<sampleId> }
    this.windows = new Map();
    this.closedWindows = new Set();
    this.lastWatermark = -Infinity;
  }

  getWindow(windowStart) {
    let win = this.windows.get(windowStart);
    if (!win) {
      win = { sample: new Map(), qc: new Map(), joined: new Set() };
      this.windows.set(windowStart, win);
    }
    return win;
  }

  joinedRecord(windowStart, sampleId, win) {
    return {
      type: 'JOINED',
      sampleId,
      windowStart,
      windowEnd: windowStart + WINDOW_MS,
      sample: win.sample.get(sampleId) ?? null,
      qc: win.qc.get(sampleId) ?? null,
    };
  }

  // Returns the array of output records produced by this input record.
  process(record) {
    if (record.type === 'EVENT') return this.processEvent(record);
    if (record.type === 'WATERMARK') return this.processWatermark(record.time);
    throw malformed(`unknown record type: ${String(record.type)}`);
  }

  processEvent(record) {
    const windowStart = windowStartOf(record.eventTime);
    if (this.closedWindows.has(windowStart)) {
      return [{ type: 'LATE', reason: 'WINDOW_CLOSED', record }];
    }
    const win = this.getWindow(windowStart);
    const side = record.event === 'SAMPLE_ACQUIRED' ? 'sample' : 'qc';
    const other = side === 'sample' ? 'qc' : 'sample';

    if (record.op === 'UPSERT') {
      win[side].set(record.sampleId, record);
      if (!win.joined.has(record.sampleId) && win[other].has(record.sampleId)) {
        win.joined.add(record.sampleId);
        return [this.joinedRecord(windowStart, record.sampleId, win)];
      }
      return [];
    }

    // RETRACT
    if (!win[side].has(record.sampleId)) {
      throw new JoinError(
        'UNKNOWN_RETRACT',
        `no ${record.event} event for sampleId "${record.sampleId}" in window ${windowStart}`,
        { sampleId: record.sampleId, event: record.event, windowStart }
      );
    }
    win[side].delete(record.sampleId);
    if (win.joined.has(record.sampleId)) {
      win.joined.delete(record.sampleId);
      return [{
        type: 'WITHDRAW',
        sampleId: record.sampleId,
        windowStart,
        windowEnd: windowStart + WINDOW_MS,
      }];
    }
    return [];
  }

  processWatermark(time) {
    if (time <= this.lastWatermark) return [];
    this.lastWatermark = time;
    const outputs = [];
    const closing = [...this.windows.keys()]
      .filter((ws) => ws + WINDOW_MS <= time)
      .sort((a, b) => a - b);
    for (const windowStart of closing) {
      const win = this.windows.get(windowStart);
      // Reference algorithm: brute-force match both side sets of the window.
      const sampleIds = new Set([...win.sample.keys(), ...win.qc.keys()]);
      for (const sampleId of [...sampleIds].sort()) {
        const hasSample = win.sample.has(sampleId);
        const hasQc = win.qc.has(sampleId);
        if (hasSample && hasQc) {
          if (!win.joined.has(sampleId)) {
            win.joined.add(sampleId);
            outputs.push(this.joinedRecord(windowStart, sampleId, win));
          }
        } else {
          outputs.push({
            type: 'EXPIRED_UNJOINED',
            sampleId,
            side: hasSample ? 'SAMPLE_ACQUIRED' : 'QC_RESULT',
            windowStart,
            windowEnd: windowStart + WINDOW_MS,
          });
        }
      }
      this.windows.delete(windowStart);
      this.closedWindows.add(windowStart);
    }
    return outputs;
  }
}

module.exports = { Joiner, JoinError, validateRecord, windowStartOf, WINDOW_MS };
