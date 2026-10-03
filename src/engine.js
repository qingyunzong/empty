import { createHash } from 'node:crypto';

export const PANE_WIDTH_MS = 10 * 60 * 1000;
export const PANE_SLIDE_MS = 2 * 60 * 1000;
export const FINALIZE_DELAY_MS = 60 * 1000;
export const MAX_VERSIONS_PER_SAMPLE = 8;
export const OUTLIER_MAD_FACTOR = 3;
export const OUTLIER_ABS_THRESHOLD = 5;

export function paneStartsFor(ts) {
  const last = Math.floor(ts / PANE_SLIDE_MS) * PANE_SLIDE_MS;
  const starts = [];
  for (let start = last; start + PANE_WIDTH_MS > ts; start -= PANE_SLIDE_MS) {
    starts.push(start);
  }
  return starts.reverse();
}

export function medianOf(sortedValues) {
  const count = sortedValues.length;
  if (count === 0) return null;
  const mid = count >>> 1;
  return count % 2 === 1 ? sortedValues[mid] : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

export function computeStats(points) {
  const entries = [...points.entries()];
  if (entries.length === 0) return { median: null, mad: null, outlierIds: [] };
  const temps = entries.map(([, point]) => point.temp).sort((a, b) => a - b);
  const median = medianOf(temps);
  const deviations = temps.map((temp) => Math.abs(temp - median)).sort((a, b) => a - b);
  const mad = medianOf(deviations);
  const outlierIds = entries
    .filter(([, point]) => {
      const distance = Math.abs(point.temp - median);
      return distance > OUTLIER_MAD_FACTOR * mad || distance >= OUTLIER_ABS_THRESHOLD;
    })
    .map(([sampleId]) => sampleId)
    .sort();
  return { median, mad, outlierIds };
}

export function certificateOf(sensorId, paneStart, points) {
  const samples = [...points.entries()]
    .map(([sampleId, point]) => [sampleId, point.temp, point.version])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = JSON.stringify({ sensorId, paneStart, samples });
  return createHash('sha256').update(canonical).digest('hex');
}

export class WindowEngine {
  constructor() {
    this.sensors = new Map();
    this.globalWatermark = -Infinity;
  }

  ingest(event) {
    switch (event.type) {
      case 'UPSERT':
        return this.#upsert(event);
      case 'RETRACT':
        return this.#retract(event);
      case 'WATERMARK':
        return this.#watermark(event);
      default:
        return { outputs: [], errors: [{ error: 'UNKNOWN_EVENT_TYPE', type: event.type ?? null }] };
    }
  }

  #sensor(sensorId) {
    let sensor = this.sensors.get(sensorId);
    if (!sensor) {
      sensor = { samples: new Map(), panes: new Map(), watermark: -Infinity };
      this.sensors.set(sensorId, sensor);
    }
    return sensor;
  }

  #pane(sensor, paneStart) {
    let pane = sensor.panes.get(paneStart);
    if (!pane) {
      pane = { points: new Map(), lastResult: null, finalized: false };
      sensor.panes.set(paneStart, pane);
    }
    return pane;
  }

  #isLate(sensor, paneStart) {
    const watermark = Math.max(this.globalWatermark, sensor.watermark);
    return paneStart + PANE_WIDTH_MS + FINALIZE_DELAY_MS <= watermark;
  }

  #upsert({ sensorId, sampleId, ts, temp }) {
    const sensor = this.#sensor(sensorId);
    const existing = sensor.samples.get(sampleId);
    const involved = new Set(paneStartsFor(ts));
    if (existing) {
      for (const paneStart of paneStartsFor(existing.ts)) involved.add(paneStart);
    }
    for (const paneStart of involved) {
      if (sensor.panes.get(paneStart)?.finalized || this.#isLate(sensor, paneStart)) {
        return { outputs: [], errors: [{ error: 'LATE', sensorId, sampleId, ts, paneStart }] };
      }
    }
    const version = existing ? existing.version + 1 : 1;
    if (version > MAX_VERSIONS_PER_SAMPLE) {
      return {
        outputs: [],
        errors: [{ error: 'BUDGET_EXCEEDED', sensorId, sampleId, version, maxVersions: MAX_VERSIONS_PER_SAMPLE }],
      };
    }
    if (existing) {
      for (const paneStart of paneStartsFor(existing.ts)) {
        sensor.panes.get(paneStart)?.points.delete(sampleId);
      }
    }
    sensor.samples.set(sampleId, { ts, temp, version });
    for (const paneStart of paneStartsFor(ts)) {
      this.#pane(sensor, paneStart).points.set(sampleId, { temp, version });
    }
    const outputs = [];
    for (const paneStart of [...involved].sort((a, b) => a - b)) {
      this.#emitDiff(sensorId, paneStart, sensor.panes.get(paneStart), outputs);
    }
    return { outputs, errors: [] };
  }

  #retract({ sensorId, sampleId }) {
    const sensor = this.sensors.get(sensorId);
    const existing = sensor?.samples.get(sampleId);
    if (!existing) {
      return { outputs: [], errors: [{ error: 'UNKNOWN_RETRACT', sensorId, sampleId }] };
    }
    const starts = paneStartsFor(existing.ts);
    for (const paneStart of starts) {
      if (sensor.panes.get(paneStart)?.finalized || this.#isLate(sensor, paneStart)) {
        return { outputs: [], errors: [{ error: 'LATE', sensorId, sampleId, ts: existing.ts, paneStart }] };
      }
    }
    for (const paneStart of starts) sensor.panes.get(paneStart).points.delete(sampleId);
    sensor.samples.delete(sampleId);
    const outputs = [];
    for (const paneStart of starts) {
      this.#emitDiff(sensorId, paneStart, sensor.panes.get(paneStart), outputs);
    }
    return { outputs, errors: [] };
  }

  #watermark({ ts, sensorId }) {
    const outputs = [];
    if (sensorId === undefined || sensorId === null) {
      this.globalWatermark = Math.max(this.globalWatermark, ts);
      for (const [sid, sensor] of [...this.sensors.entries()].sort()) {
        this.#finalize(sid, sensor, outputs);
      }
    } else {
      const sensor = this.#sensor(sensorId);
      sensor.watermark = Math.max(sensor.watermark, ts);
      this.#finalize(sensorId, sensor, outputs);
    }
    return { outputs, errors: [] };
  }

  #finalize(sensorId, sensor, outputs) {
    const watermark = Math.max(this.globalWatermark, sensor.watermark);
    const starts = [...sensor.panes.keys()].sort((a, b) => a - b);
    for (const paneStart of starts) {
      const pane = sensor.panes.get(paneStart);
      if (pane.finalized) continue;
      if (paneStart + PANE_WIDTH_MS + FINALIZE_DELAY_MS <= watermark) {
        pane.finalized = true;
        const result = pane.lastResult ?? {
          median: null,
          mad: null,
          outlierIds: [],
          certificate: certificateOf(sensorId, paneStart, pane.points),
        };
        outputs.push({ op: 'FINAL', sensorId, paneStart, ...result });
      }
    }
  }

  #emitDiff(sensorId, paneStart, pane, outputs) {
    const stats = computeStats(pane.points);
    const next =
      stats.median === null
        ? null
        : { ...stats, certificate: certificateOf(sensorId, paneStart, pane.points) };
    const prev = pane.lastResult;
    if (prev === null && next === null) return;
    if (prev === null) {
      outputs.push({ op: 'ADD', sensorId, paneStart, ...next });
    } else if (next === null) {
      outputs.push({ op: 'WITHDRAW', sensorId, paneStart, ...prev });
    } else if (prev.certificate !== next.certificate) {
      outputs.push({ op: 'WITHDRAW', sensorId, paneStart, ...prev });
      outputs.push({ op: 'CORRECTION', sensorId, paneStart, ...next });
    }
    pane.lastResult = next;
  }
}
