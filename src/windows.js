import { createHash } from 'node:crypto';

export const PANE_WIDTH_MS = 10 * 60 * 1000;
export const PANE_SLIDE_MS = 2 * 60 * 1000;
export const FINALIZE_DELAY_MS = 60 * 1000;
export const MAX_VERSION_UPDATES = 8;

export class FatalInputError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FatalInputError';
    this.code = 'INVALID_INPUT';
    this.detail = detail;
  }
}

export function panesForTimestamp(ts) {
  const latest = Math.floor(ts / PANE_SLIDE_MS) * PANE_SLIDE_MS;
  const starts = [];
  for (let start = latest; start > ts - PANE_WIDTH_MS; start -= PANE_SLIDE_MS) {
    starts.push(start);
  }
  return starts.reverse();
}

function medianOf(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computePaneResult(samples, paneStart) {
  const points = [];
  for (const sample of samples) {
    if (
      sample.ts >= paneStart &&
      sample.ts < paneStart + PANE_WIDTH_MS &&
      Number.isFinite(sample.temp)
    ) {
      points.push(sample);
    }
  }
  if (points.length === 0) {
    return { median: null, mad: null, outlierIds: [] };
  }
  const temps = points.map((p) => p.temp).sort((a, b) => a - b);
  const median = medianOf(temps);
  const deviations = points
    .map((p) => Math.abs(p.temp - median))
    .sort((a, b) => a - b);
  const mad = medianOf(deviations);
  const outlierIds = points
    .filter((p) => {
      const d = Math.abs(p.temp - median);
      return d > 3 * mad || d >= 5;
    })
    .map((p) => p.sampleId)
    .sort();
  return { median, mad, outlierIds };
}

function certificateFor(record) {
  const canonical = JSON.stringify({
    sensorId: record.sensorId,
    paneStart: record.paneStart,
    median: record.median,
    mad: record.mad,
    outlierIds: record.outlierIds,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function makeRecord(sensorId, paneStart, result) {
  const record = {
    sensorId,
    paneStart,
    median: result.median,
    mad: result.mad,
    outlierIds: result.outlierIds,
  };
  record.certificate = certificateFor(record);
  return record;
}

function sameResult(a, b) {
  return (
    a !== null &&
    b !== null &&
    a.median === b.median &&
    a.mad === b.mad &&
    a.outlierIds.length === b.outlierIds.length &&
    a.outlierIds.every((id, i) => id === b.outlierIds[i])
  );
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(event, field) {
  if (typeof event[field] !== 'string' || event[field].length === 0) {
    throw new FatalInputError(`missing or invalid field: ${field}`, {
      field,
      event,
    });
  }
  return event[field];
}

function requireNumber(event, field) {
  if (typeof event[field] !== 'number' || !Number.isFinite(event[field])) {
    throw new FatalInputError(`missing or invalid field: ${field}`, {
      field,
      event,
    });
  }
  return event[field];
}

class SensorState {
  constructor() {
    this.samples = new Map();
    this.corrections = 0;
    this.watermark = -Infinity;
    this.panes = new Map();
  }
}

export class WindowEngine {
  constructor() {
    this.sensors = new Map();
  }

  sensorState(sensorId) {
    let state = this.sensors.get(sensorId);
    if (!state) {
      state = new SensorState();
      this.sensors.set(sensorId, state);
    }
    return state;
  }


  apply(event) {
    if (!isObject(event) || typeof event.type !== 'string') {
      throw new FatalInputError('event must be an object with a type', { event });
    }
    switch (event.type) {
      case 'UPSERT':
        return this.applyUpsert(event);
      case 'RETRACT':
        return this.applyRetract(event);
      case 'WATERMARK':
        return this.applyWatermark(event);
      default:
        throw new FatalInputError(`unknown event type: ${event.type}`, { event });
    }
  }

  applyUpsert(event) {
    const sensorId = requireString(event, 'sensorId');
    const sampleId = requireString(event, 'sampleId');
    const ts = requireNumber(event, 'ts');
    const temp = requireNumber(event, 'temp');
    if (event.version !== undefined) {
      requireNumber(event, 'version');
    }
    const sensor = this.sensorState(sensorId);
    const existing = sensor.samples.get(sampleId);

    const affected = new Set(panesForTimestamp(ts));
    if (existing) {
      for (const start of panesForTimestamp(existing.ts)) affected.add(start);
    }
    for (const start of affected) {
      const pane = sensor.panes.get(start);
      if (pane && pane.finalized) {
        return {
          outputs: [],
          error: {
            error: 'LATE',
            sensorId,
            sampleId,
            paneStart: start,
            message: 'pane already finalized',
          },
        };
      }
    }

    if (existing) {
      if (event.version !== undefined && event.version <= existing.version) {
        return { outputs: [], error: null };
      }
      if (sensor.corrections >= MAX_VERSION_UPDATES) {
        return {
          outputs: [],
          error: {
            error: 'BUDGET_EXCEEDED',
            sensorId,
            sampleId,
            message: `sensor ${sensorId} exceeded ${MAX_VERSION_UPDATES} version updates`,
          },
        };
      }
      sensor.corrections += 1;
    }

    const version =
      event.version !== undefined
        ? event.version
        : existing
          ? existing.version + 1
          : 1;
    sensor.samples.set(sampleId, { sampleId, ts, temp, version });
    return { outputs: this.refreshPanes(sensorId, sensor, affected), error: null };
  }

  applyRetract(event) {
    const sensorId = requireString(event, 'sensorId');
    const sampleId = requireString(event, 'sampleId');
    const sensor = this.sensors.get(sensorId);
    const existing = sensor ? sensor.samples.get(sampleId) : undefined;
    if (!existing) {
      return {
        outputs: [],
        error: {
          error: 'UNKNOWN_RETRACT',
          sensorId,
          sampleId,
          message: 'retract of unknown sample',
        },
      };
    }
    const affected = new Set(panesForTimestamp(existing.ts));
    for (const start of affected) {
      const pane = sensor.panes.get(start);
      if (pane && pane.finalized) {
        return {
          outputs: [],
          error: {
            error: 'LATE',
            sensorId,
            sampleId,
            paneStart: start,
            message: 'pane already finalized',
          },
        };
      }
    }
    sensor.samples.delete(sampleId);
    return { outputs: this.refreshPanes(sensorId, sensor, affected), error: null };
  }

  applyWatermark(event) {
    const sensorId = requireString(event, 'sensorId');
    const ts = requireNumber(event, 'ts');
    const sensor = this.sensorState(sensorId);
    if (ts <= sensor.watermark) {
      return { outputs: [], error: null };
    }
    sensor.watermark = ts;
    const outputs = [];
    const starts = [...sensor.panes.keys()].sort((a, b) => a - b);
    for (const start of starts) {
      const pane = sensor.panes.get(start);
      if (pane.finalized) continue;
      if (start + PANE_WIDTH_MS + FINALIZE_DELAY_MS <= sensor.watermark) {
        pane.finalized = true;
        const result = computePaneResult(sensor.samples.values(), start);
        const record = makeRecord(sensorId, start, result);
        pane.emitted = record;
        outputs.push({ op: 'FINAL', ...record });
      }
    }
    return { outputs, error: null };
  }

  refreshPanes(sensorId, sensor, affected) {
    const outputs = [];
    const starts = [...affected].sort((a, b) => a - b);
    for (const start of starts) {
      let pane = sensor.panes.get(start);
      if (!pane) {
        pane = { finalized: false, emitted: null };
        sensor.panes.set(start, pane);
      }
      if (pane.finalized) continue;
      const result = computePaneResult(sensor.samples.values(), start);
      const record = makeRecord(sensorId, start, result);
      if (pane.emitted === null) {
        pane.emitted = record;
        outputs.push({ op: 'ADD', ...record });
      } else if (!sameResult(pane.emitted, record)) {
        outputs.push({ op: 'WITHDRAW', ...pane.emitted });
        outputs.push({ op: 'CORRECTION', ...record });
        pane.emitted = record;
      }
    }
    return outputs;
  }
}
