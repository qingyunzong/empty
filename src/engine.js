export const WINDOW_SIZE_MS = 15 * 60 * 1000;
export const SLIDE_MS = 5 * 60 * 1000;
export const ALLOWED_LATENESS_MS = 60 * 1000;

const RECORD_TYPES = new Set(['FLUX', 'CALIBRATION']);
const OPS = new Set(['UPSERT', 'RETRACT']);

function round6(x) {
  return Number(x.toFixed(6));
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

export class FluxEngine {
  constructor({
    windowSizeMs = WINDOW_SIZE_MS,
    slideMs = SLIDE_MS,
    allowedLatenessMs = ALLOWED_LATENESS_MS,
  } = {}) {
    this.windowSizeMs = windowSizeMs;
    this.slideMs = slideMs;
    this.allowedLatenessMs = allowedLatenessMs;
    this.samples = new Map();
    this.calibrations = new Map();
    this.watermark = -Infinity;
    this.paneState = new Map();
  }

  ingestLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return [this.#error('MALFORMED', null, 'line is not valid JSON')];
    }
    return this.ingest(event);
  }

  ingest(event) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      return [this.#error('MALFORMED', event, 'event must be an object')];
    }
    const { type, op = 'UPSERT' } = event;
    if (!RECORD_TYPES.has(type)) {
      return [this.#error('MALFORMED', event, `unknown type: ${String(type)}`)];
    }
    if (!OPS.has(op)) {
      return [this.#error('MALFORMED', event, `unknown op: ${String(op)}`)];
    }
    if (typeof event.id !== 'string' || event.id.length === 0) {
      return [this.#error('MALFORMED', event, 'id must be a non-empty string')];
    }
    return op === 'RETRACT' ? this.#retract(type, event) : this.#upsert(type, event);
  }

  #upsert(type, event) {
    if (typeof event.sensorId !== 'string' || event.sensorId.length === 0) {
      return [this.#error('MALFORMED', event, 'sensorId must be a non-empty string')];
    }
    let record;
    if (type === 'FLUX') {
      if (!isFiniteNumber(event.ts) || event.ts < 0) {
        return [this.#error('MALFORMED', event, 'ts must be a finite number >= 0')];
      }
      if (!isFiniteNumber(event.value)) {
        return [this.#error('MALFORMED', event, 'value must be a finite number')];
      }
      record = {
        id: event.id,
        sensorId: event.sensorId,
        ts: event.ts,
        value: event.value,
      };
    } else {
      if (!Number.isInteger(event.version)) {
        return [this.#error('MALFORMED', event, 'version must be an integer')];
      }
      if (!isFiniteNumber(event.effectiveFrom) || event.effectiveFrom < 0) {
        return [this.#error('MALFORMED', event, 'effectiveFrom must be a finite number >= 0')];
      }
      if (!isFiniteNumber(event.expireAt)) {
        return [this.#error('MALFORMED', event, 'expireAt must be a finite number')];
      }
      if (!isFiniteNumber(event.factor)) {
        return [this.#error('MALFORMED', event, 'factor must be a finite number')];
      }
      if (event.expireAt <= event.effectiveFrom) {
        return [this.#error('INVALID_RANGE', event, 'expireAt must be greater than effectiveFrom')];
      }
      record = {
        id: event.id,
        sensorId: event.sensorId,
        version: event.version,
        effectiveFrom: event.effectiveFrom,
        expireAt: event.expireAt,
        factor: event.factor,
      };
    }

    const eventTime = type === 'FLUX' ? record.ts : record.effectiveFrom;
    if (this.#isLate(eventTime)) {
      return [this.#error('LATE', event, `event time ${eventTime} is beyond a frozen pane`)];
    }

    const store = type === 'FLUX' ? this.samples : this.calibrations;
    const previous = store.get(record.id) ?? null;
    store.set(record.id, record);
    this.watermark = Math.max(this.watermark, eventTime);

    const outputs = [];
    if (previous) outputs.push(...this.#recomputeForRecord(type, previous));
    outputs.push(...this.#recomputeForRecord(type, record));
    return outputs;
  }

  #retract(type, event) {
    const store = type === 'FLUX' ? this.samples : this.calibrations;
    const existing = store.get(event.id);
    if (!existing) {
      return [this.#error('UNKNOWN_RETRACT', event, `no ${type} record with id ${event.id}`)];
    }
    const eventTime = type === 'FLUX' ? existing.ts : existing.effectiveFrom;
    if (this.#isLate(eventTime)) {
      return [this.#error('LATE', event, `retraction targets a frozen pane`)];
    }
    store.delete(event.id);
    return this.#recomputeForRecord(type, existing);
  }

  #isLate(eventTime) {
    const latestStart = Math.floor(eventTime / this.slideMs) * this.slideMs;
    const latestEnd = latestStart + this.windowSizeMs;
    return this.watermark > latestEnd + this.allowedLatenessMs;
  }

  #isFrozen(paneStart) {
    return this.watermark > paneStart + this.windowSizeMs + this.allowedLatenessMs;
  }

  #recomputeForRecord(type, record) {
    const from = type === 'FLUX' ? record.ts : record.effectiveFrom;
    const to = type === 'FLUX' ? record.ts + 1 : record.expireAt;
    return this.#recomputeRange(record.sensorId, from, to);
  }

  #recomputeRange(sensorId, from, to) {
    const kMin = Math.max(0, Math.floor((from - this.windowSizeMs + 1) / this.slideMs));
    const kMax = Math.floor(Math.max(from, to - 1) / this.slideMs);
    const outputs = [];
    for (let k = kMin; k <= kMax; k++) {
      outputs.push(...this.#recomputePane(sensorId, k));
    }
    return outputs;
  }

  #recomputePane(sensorId, k) {
    const start = k * this.slideMs;
    const end = start + this.windowSizeMs;
    const paneKey = `${sensorId}#${k}`;
    if (this.#isFrozen(start)) return [];

    const samples = [];
    for (const sample of this.samples.values()) {
      if (sample.sensorId === sensorId && sample.ts >= start && sample.ts < end) {
        samples.push(sample);
      }
    }
    const previous = this.paneState.get(paneKey) ?? null;

    if (samples.length === 0) {
      if (previous) {
        this.paneState.delete(paneKey);
        return [{ ...previous, type: 'WITHDRAW' }];
      }
      return [];
    }

    samples.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

    const n = samples.length;
    const weights = new Array(n);
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const left = i === 0 ? start : (samples[i - 1].ts + samples[i].ts) / 2;
      const right = i === n - 1 ? end : (samples[i].ts + samples[i + 1].ts) / 2;
      weights[i] = Math.max(0, right - left);
      totalWeight += weights[i];
    }
    if (!(totalWeight > 0)) {
      return [this.#error('MALFORMED', { pane: paneKey }, `weight sum anomaly: ${totalWeight}`)];
    }

    const segments = [];
    let weightedSum = 0;
    let calibratedCount = 0;
    for (let i = 0; i < n; i++) {
      const calibration = this.#calibrationAt(sensorId, samples[i].ts);
      const factor = calibration ? calibration.factor : 1;
      if (calibration) calibratedCount++;
      weightedSum += samples[i].value * factor * weights[i];
      const segKey = calibration ? calibration.id : null;
      const last = segments[segments.length - 1];
      if (last && last.calibrationId === segKey) {
        last.to = samples[i].ts;
        last.weight = round6(last.weight + weights[i]);
        last.samples.push(samples[i].id);
      } else {
        segments.push({
          version: calibration ? calibration.version : null,
          calibrationId: segKey,
          factor,
          from: samples[i].ts,
          to: samples[i].ts,
          weight: round6(weights[i]),
          samples: [samples[i].id],
        });
      }
    }

    const status =
      calibratedCount === 0
        ? 'UNCALIBRATED'
        : calibratedCount === n
          ? 'CALIBRATED'
          : 'PARTIAL';

    const result = {
      type: 'ADD',
      pane: paneKey,
      windowStart: start,
      windowEnd: end,
      status,
      weightedFlux: round6(weightedSum / totalWeight),
      totalWeight: round6(totalWeight),
      segments,
      evidence: samples.map((s) => s.id),
    };

    if (previous && JSON.stringify(previous) === JSON.stringify(result)) {
      return [];
    }
    const outputs = [];
    if (previous) outputs.push({ ...previous, type: 'WITHDRAW' });
    outputs.push(result);
    this.paneState.set(paneKey, result);
    return outputs;
  }

  #calibrationAt(sensorId, t) {
    let best = null;
    for (const calibration of this.calibrations.values()) {
      if (calibration.sensorId !== sensorId) continue;
      if (calibration.effectiveFrom <= t && t < calibration.expireAt) {
        if (!best || calibration.version > best.version) best = calibration;
      }
    }
    return best;
  }

  #error(code, record, message) {
    return { type: 'ERROR', code, message, record: record ?? null };
  }
}
