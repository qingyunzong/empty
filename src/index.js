// Core library: event-time tumbling-window join of SAMPLE_ACQUIRED / QC_RESULT.
// Standard library only.

export const WINDOW_MS = 5 * 60 * 1000; // 5-minute tumbling windows

export const EVENT_TYPES = new Set(['SAMPLE_ACQUIRED', 'QC_RESULT']);

export class JoinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JoinError';
    this.code = code; // MALFORMED | UNKNOWN_RETRACT | DURABLE_STATE_CORRUPT
  }
}

export function windowStartOf(eventTime) {
  return Math.floor(eventTime / WINDOW_MS) * WINDOW_MS;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function malformed(message) {
  throw new JoinError('MALFORMED', message);
}

// Syntactic validation of one input record. Throws JoinError(MALFORMED).
export function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    malformed('record must be a JSON object');
  }
  switch (record.type) {
    case 'UPSERT':
      if (!EVENT_TYPES.has(record.eventType)) malformed('UPSERT requires eventType SAMPLE_ACQUIRED|QC_RESULT');
      if (!isNonEmptyString(record.eventId)) malformed('UPSERT requires non-empty string eventId');
      if (!isNonEmptyString(record.sampleId)) malformed('UPSERT requires non-empty string sampleId');
      if (!isValidTime(record.eventTime)) malformed('UPSERT requires finite eventTime >= 0');
      return;
    case 'RETRACT':
      if (!EVENT_TYPES.has(record.eventType)) malformed('RETRACT requires eventType SAMPLE_ACQUIRED|QC_RESULT');
      if (!isNonEmptyString(record.eventId)) malformed('RETRACT requires non-empty string eventId');
      if (!isValidTime(record.eventTime)) malformed('RETRACT requires finite eventTime >= 0');
      return;
    case 'WATERMARK':
      if (!isValidTime(record.time)) malformed('WATERMARK requires finite time >= 0');
      return;
    default:
      malformed(`unknown record type: ${String(record.type)}`);
  }
}

function byTimeThenId(a, b) {
  return a.eventTime - b.eventTime || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
}

function matchSortKey(m) {
  return `${m.sampleId} ${m.sampleEventId} ${m.qcEventId}`;
}

// Reference algorithm: enumerate both side sets of one window and brute-force
// pair events sharing the same sampleId, one-to-one, in (eventTime, eventId) order.
function computeMatches(windowStart, window) {
  const sampleIds = new Set();
  const samplesById = new Map();
  const qcById = new Map();
  for (const e of window.samples.values()) {
    sampleIds.add(e.sampleId);
    if (!samplesById.has(e.sampleId)) samplesById.set(e.sampleId, []);
    samplesById.get(e.sampleId).push(e);
  }
  for (const e of window.qc.values()) {
    sampleIds.add(e.sampleId);
    if (!qcById.has(e.sampleId)) qcById.set(e.sampleId, []);
    qcById.get(e.sampleId).push(e);
  }
  const matches = new Map();
  for (const sampleId of [...sampleIds].sort()) {
    const samples = (samplesById.get(sampleId) || []).slice().sort(byTimeThenId);
    const qcs = (qcById.get(sampleId) || []).slice().sort(byTimeThenId);
    const n = Math.min(samples.length, qcs.length);
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const q = qcs[i];
      const match = {
        type: 'JOINED',
        windowStart,
        sampleId,
        sampleEventId: s.eventId,
        qcEventId: q.eventId,
        sampleTime: s.eventTime,
        qcTime: q.eventTime,
      };
      matches.set(`${s.eventId} ${q.eventId}`, match);
    }
  }
  return matches;
}

export class Joiner {
  constructor() {
    this.windows = new Map(); // windowStart -> { samples: Map, qc: Map, matches: Map }
    this.eventIndex = new Map(); // eventId -> windowStart
    this.watermark = -1;
  }

  // Process one validated record; returns an array of output records (deterministic order).
  process(record) {
    switch (record.type) {
      case 'UPSERT':
        return this.#upsert(record);
      case 'RETRACT':
        return this.#retract(record);
      case 'WATERMARK':
        return this.#advanceWatermark(record.time);
      default:
        malformed(`unknown record type: ${String(record.type)}`);
    }
  }

  #getWindow(windowStart) {
    let win = this.windows.get(windowStart);
    if (!win) {
      win = { samples: new Map(), qc: new Map(), matches: new Map() };
      this.windows.set(windowStart, win);
    }
    return win;
  }

  #isClosed(windowStart) {
    return windowStart + WINDOW_MS <= this.watermark;
  }

  #upsert(record) {
    const windowStart = windowStartOf(record.eventTime);
    if (this.#isClosed(windowStart)) {
      return [{ type: 'LATE', record }];
    }
    const outputs = [];
    const previousWindow = this.eventIndex.get(record.eventId);
    if (previousWindow !== undefined && previousWindow !== windowStart) {
      outputs.push(...this.#removeEvent(previousWindow, record.eventId));
    }
    const win = this.#getWindow(windowStart);
    const side = record.eventType === 'SAMPLE_ACQUIRED' ? win.samples : win.qc;
    side.set(record.eventId, {
      eventId: record.eventId,
      sampleId: record.sampleId,
      eventTime: record.eventTime,
      eventType: record.eventType,
    });
    this.eventIndex.set(record.eventId, windowStart);
    outputs.push(...this.#recompute(windowStart));
    return outputs;
  }

  #retract(record) {
    const windowStart = windowStartOf(record.eventTime);
    if (this.#isClosed(windowStart)) {
      return [{ type: 'LATE', record }];
    }
    const existingWindow = this.eventIndex.get(record.eventId);
    if (existingWindow === undefined) {
      throw new JoinError('UNKNOWN_RETRACT', `no live event with eventId ${record.eventId}`);
    }
    return this.#removeEvent(existingWindow, record.eventId);
  }

  #removeEvent(windowStart, eventId) {
    const win = this.windows.get(windowStart);
    if (!win) return [];
    win.samples.delete(eventId);
    win.qc.delete(eventId);
    this.eventIndex.delete(eventId);
    return this.#recompute(windowStart);
  }

  // Diff the window's matching before/after a change: removed pairs -> WITHDRAW, added -> JOINED.
  #recompute(windowStart) {
    const win = this.windows.get(windowStart);
    if (!win) return [];
    const next = computeMatches(windowStart, win);
    const withdraws = [];
    const joins = [];
    for (const [key, m] of win.matches) {
      if (!next.has(key)) withdraws.push({ ...m, type: 'WITHDRAW' });
    }
    for (const [key, m] of next) {
      if (!win.matches.has(key)) joins.push(m);
    }
    win.matches = next;
    withdraws.sort((a, b) => (matchSortKey(a) < matchSortKey(b) ? -1 : 1));
    joins.sort((a, b) => (matchSortKey(a) < matchSortKey(b) ? -1 : 1));
    return [...withdraws, ...joins];
  }

  #advanceWatermark(time) {
    if (time <= this.watermark) return [];
    this.watermark = time;
    const outputs = [];
    const closing = [...this.windows.keys()]
      .filter((ws) => ws + WINDOW_MS <= time)
      .sort((a, b) => a - b);
    for (const ws of closing) {
      const win = this.windows.get(ws);
      const matched = new Set();
      for (const m of win.matches.values()) {
        matched.add(m.sampleEventId);
        matched.add(m.qcEventId);
      }
      const leftovers = [];
      for (const e of win.samples.values()) {
        if (!matched.has(e.eventId)) leftovers.push({ side: 'SAMPLE_ACQUIRED', event: e });
      }
      for (const e of win.qc.values()) {
        if (!matched.has(e.eventId)) leftovers.push({ side: 'QC_RESULT', event: e });
      }
      leftovers.sort((a, b) => byTimeThenId(a.event, b.event));
      for (const { side, event } of leftovers) {
        outputs.push({
          type: 'EXPIRED_UNJOINED',
          windowStart: ws,
          side,
          eventId: event.eventId,
          sampleId: event.sampleId,
          eventTime: event.eventTime,
        });
      }
      for (const e of win.samples.values()) this.eventIndex.delete(e.eventId);
      for (const e of win.qc.values()) this.eventIndex.delete(e.eventId);
      this.windows.delete(ws);
    }
    return outputs;
  }
}
