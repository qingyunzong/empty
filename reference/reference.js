// Independent small-scale reference implementation used only by tests.
// Shares no code with src/: for every pane it re-collects the valid points
// from scratch, sorts them, and brute-force enumerates the outliers.

const WIDTH_MS = 10 * 60 * 1000;
const SLIDE_MS = 2 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const MAX_VERSIONS = 8;

function panesCovering(ts) {
  const latest = Math.floor(ts / SLIDE_MS) * SLIDE_MS;
  const starts = [];
  for (let s = latest; s + WIDTH_MS > ts; s -= SLIDE_MS) starts.push(s);
  return starts;
}

function middle(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const half = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[half];
  return (sorted[half - 1] + sorted[half]) / 2;
}

function bruteForcePane(samples, paneStart) {
  const ids = [];
  const values = [];
  for (const [id, sample] of samples) {
    if (sample.ts >= paneStart && sample.ts < paneStart + WIDTH_MS) {
      ids.push(id);
      values.push(sample.temp);
    }
  }
  if (values.length === 0) return { median: null, mad: null, outlierIds: [] };
  const sortedValues = [...values].sort((a, b) => a - b);
  const median = middle(sortedValues);
  const sortedDeviations = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = middle(sortedDeviations);
  const outlierIds = [];
  for (let i = 0; i < ids.length; i += 1) {
    const distance = Math.abs(values[i] - median);
    if (distance > 3 * mad || distance >= 5) outlierIds.push(ids[i]);
  }
  outlierIds.sort();
  return { median, mad, outlierIds };
}

export function runReference(events) {
  const sensors = new Map();
  let globalWatermark = -Infinity;
  const errors = [];

  const sensorOf = (sensorId) => {
    if (!sensors.has(sensorId)) {
      sensors.set(sensorId, { samples: new Map(), touchedPanes: new Set(), watermark: -Infinity });
    }
    return sensors.get(sensorId);
  };
  const watermarkOf = (sensor) => Math.max(globalWatermark, sensor.watermark);
  const isFinalized = (sensor, paneStart) => paneStart + WIDTH_MS + GRACE_MS <= watermarkOf(sensor);

  for (const event of events) {
    if (event.type === 'UPSERT') {
      const sensor = sensorOf(event.sensorId);
      const previous = sensor.samples.get(event.sampleId);
      const involved = new Set(panesCovering(event.ts));
      if (previous) for (const p of panesCovering(previous.ts)) involved.add(p);
      if ([...involved].some((p) => isFinalized(sensor, p))) {
        errors.push({ error: 'LATE', sensorId: event.sensorId, sampleId: event.sampleId });
        continue;
      }
      const version = previous ? previous.version + 1 : 1;
      if (version > MAX_VERSIONS) {
        errors.push({ error: 'BUDGET_EXCEEDED', sensorId: event.sensorId, sampleId: event.sampleId });
        continue;
      }
      sensor.samples.set(event.sampleId, { ts: event.ts, temp: event.temp, version });
      for (const p of involved) sensor.touchedPanes.add(p);
    } else if (event.type === 'RETRACT') {
      const sensor = sensors.get(event.sensorId);
      const previous = sensor?.samples.get(event.sampleId);
      if (!previous) {
        errors.push({ error: 'UNKNOWN_RETRACT', sensorId: event.sensorId, sampleId: event.sampleId });
        continue;
      }
      if (panesCovering(previous.ts).some((p) => isFinalized(sensor, p))) {
        errors.push({ error: 'LATE', sensorId: event.sensorId, sampleId: event.sampleId });
        continue;
      }
      sensor.samples.delete(event.sampleId);
    } else if (event.type === 'WATERMARK') {
      if (event.sensorId === undefined || event.sensorId === null) {
        globalWatermark = Math.max(globalWatermark, event.ts);
      } else {
        const sensor = sensorOf(event.sensorId);
        sensor.watermark = Math.max(sensor.watermark, event.ts);
      }
    }
  }

  const finalPanes = new Map();
  for (const [sensorId, sensor] of sensors) {
    for (const paneStart of sensor.touchedPanes) {
      if (!isFinalized(sensor, paneStart)) continue;
      finalPanes.set(`${sensorId}|${paneStart}`, bruteForcePane(sensor.samples, paneStart));
    }
  }
  return { finalPanes, errors };
}
