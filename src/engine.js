import { createHash } from 'node:crypto';
import { InputError } from './errors.js';
import { compilePatterns } from './patterns.js';

export { InputError };

function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function canonicalEvents(events) {
  return events.map((e) => [e.id, e.ts, e.sym]);
}

export function fingerprintEvents(events) {
  return createHash('sha256').update(JSON.stringify(canonicalEvents(events))).digest('hex');
}

function alarmKeyOf(patternId, startId, endId) {
  return JSON.stringify([patternId, startId, endId]);
}

function compareAlarms(a, b) {
  if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
  if (a.endIndex !== b.endIndex) return a.endIndex - b.endIndex;
  if (a.patternId < b.patternId) return -1;
  if (a.patternId > b.patternId) return 1;
  return 0;
}

export function computeAlarms(windowEvents, patterns) {
  const alarms = new Map();
  const n = windowEvents.length;
  for (let start = 0; start < n; start += 1) {
    let text = '';
    for (let end = start; end < n; end += 1) {
      text += windowEvents[end].sym;
      for (const pattern of patterns) {
        if (!pattern.test(text)) continue;
        const startEvent = windowEvents[start];
        const endEvent = windowEvents[end];
        const key = alarmKeyOf(pattern.id, startEvent.id, endEvent.id);
        const span = windowEvents.slice(start, end + 1);
        alarms.set(key, {
          key,
          patternId: pattern.id,
          startId: startEvent.id,
          endId: endEvent.id,
          startIndex: start,
          endIndex: end,
          cert: {
            patternId: pattern.id,
            startId: startEvent.id,
            endId: endEvent.id,
            startTs: startEvent.ts,
            endTs: endEvent.ts,
            text,
            fingerprint: fingerprintEvents(span),
          },
        });
      }
    }
  }
  return alarms;
}

export function diffAlarms(prev, next) {
  const removed = [];
  const added = [];
  for (const [key, alarm] of prev) {
    if (!next.has(key)) removed.push(alarm);
  }
  for (const [key, alarm] of next) {
    if (!prev.has(key)) added.push(alarm);
  }
  removed.sort(compareAlarms);
  added.sort(compareAlarms);
  const outputs = [];
  for (const alarm of removed) {
    outputs.push({
      type: 'retractAlarm',
      alarm: { patternId: alarm.patternId, startId: alarm.startId, endId: alarm.endId },
      cert: alarm.cert,
    });
  }
  for (const alarm of added) {
    outputs.push({
      type: 'emit',
      alarm: { patternId: alarm.patternId, startId: alarm.startId, endId: alarm.endId },
      cert: alarm.cert,
    });
  }
  return outputs;
}

export function verifyCert(cert, windowEvents, patternSpecs) {
  if (cert === null || typeof cert !== 'object') return false;
  const spec = patternSpecs.find((p) => p.id === cert.patternId);
  if (!spec) return false;
  let pattern;
  try {
    pattern = compilePatterns([spec])[0];
  } catch {
    return false;
  }
  const startIndex = windowEvents.findIndex((e) => e.id === cert.startId);
  const endIndex = windowEvents.findIndex((e) => e.id === cert.endId);
  if (startIndex < 0 || endIndex < startIndex) return false;
  const span = windowEvents.slice(startIndex, endIndex + 1);
  const text = span.map((e) => e.sym).join('');
  if (text !== cert.text) return false;
  if (span[0].ts !== cert.startTs || span[span.length - 1].ts !== cert.endTs) return false;
  if (fingerprintEvents(span) !== cert.fingerprint) return false;
  return pattern.test(text);
}

export class Gateway {
  constructor({ patterns = [], windowSize = Infinity } = {}) {
    this.patterns = compilePatterns(patterns);
    this.patternSpecs = patterns.map((p) => ({ id: p.id, type: p.type, value: p.value }));
    this.setWindowSize(windowSize);
    this.live = new Map();
    this.alarms = new Map();
  }

  setWindowSize(n) {
    if (n !== Infinity && (!Number.isInteger(n) || n < 1)) {
      throw new InputError(`window size must be an integer >= 1, got: ${String(n)}`);
    }
    this.windowSize = n;
  }

  apply(record) {
    this.#applyRecord(record);
    const windowEvents = this.getWindowEvents();
    const next = computeAlarms(windowEvents, this.patterns);
    const outputs = diffAlarms(this.alarms, next);
    this.alarms = next;
    outputs.push({
      type: 'windowHash',
      hash: this.getWindowHash(),
      size: windowEvents.length,
      window: this.windowSize === Infinity ? null : this.windowSize,
    });
    return outputs;
  }

  #applyRecord(record) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new InputError('record must be a JSON object');
    }
    const keys = Object.keys(record);
    const ops = keys.filter((k) => k === 'upsert' || k === 'retract' || k === 'setWindow');
    if (ops.length !== 1 || keys.length !== 1) {
      throw new InputError(`record must have exactly one of upsert/retract/setWindow, got: ${keys.join(',') || '(none)'}`);
    }
    if (ops[0] === 'upsert') this.#applyUpsert(record.upsert);
    else if (ops[0] === 'retract') this.#applyRetract(record.retract);
    else this.#applySetWindow(record.setWindow);
  }

  #applyUpsert(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new InputError('upsert body must be an object');
    }
    const { id, ts, sym } = body;
    if (typeof id !== 'string' || id.length === 0) {
      throw new InputError('upsert id must be a non-empty string');
    }
    if (!Number.isInteger(ts)) {
      throw new InputError(`upsert ${id}: ts must be an integer, got: ${JSON.stringify(ts)}`);
    }
    if (typeof sym !== 'string' || sym.length === 0) {
      throw new InputError(`upsert ${id}: sym must be a non-empty string`);
    }
    this.live.set(id, { id, ts, sym });
  }

  #applyRetract(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new InputError('retract body must be an object');
    }
    const { id } = body;
    if (typeof id !== 'string' || id.length === 0) {
      throw new InputError('retract id must be a non-empty string');
    }
    if (!this.live.has(id)) {
      throw new InputError(`retract of unknown id: ${id}`);
    }
    this.live.delete(id);
  }

  #applySetWindow(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new InputError('setWindow body must be an object');
    }
    this.setWindowSize(body.n);
  }

  getWindowEvents() {
    const sorted = [...this.live.values()].sort(compareEvents);
    if (this.windowSize === Infinity) return sorted;
    return sorted.slice(-this.windowSize);
  }

  getWindowHash() {
    return fingerprintEvents(this.getWindowEvents());
  }

  getAlarms() {
    return new Map(this.alarms);
  }

  verify(cert) {
    return verifyCert(cert, this.getWindowEvents(), this.patternSpecs);
  }
}
