// Independent brute-force reference implementation.
// Shares no code with src/windows.js: for each pane it re-collects the valid
// points, sorts them, and enumerates outliers by direct comparison.

const WIDTH = 10 * 60 * 1000;
const SLIDE = 2 * 60 * 1000;

function middle(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function referencePane(sensorId, paneStart, samples) {
  const inside = [];
  for (const s of samples) {
    if (s.ts >= paneStart && s.ts < paneStart + WIDTH && Number.isFinite(s.temp)) {
      inside.push(s);
    }
  }
  if (inside.length === 0) {
    return { sensorId, paneStart, median: null, mad: null, outlierIds: [] };
  }
  const sortedTemps = inside.map((s) => s.temp).sort((a, b) => a - b);
  const med = middle(sortedTemps);
  const sortedDevs = inside.map((s) => Math.abs(s.temp - med)).sort((a, b) => a - b);
  const mad = middle(sortedDevs);
  const outlierIds = [];
  for (const s of inside) {
    const d = Math.abs(s.temp - med);
    if (d > 3 * mad || d >= 5) outlierIds.push(s.sampleId);
  }
  outlierIds.sort();
  return { sensorId, paneStart, median: med, mad, outlierIds };
}

export function referencePanesFor(ts) {
  const top = Math.floor(ts / SLIDE) * SLIDE;
  const out = [];
  for (let s = top; s > ts - WIDTH; s -= SLIDE) out.push(s);
  return out.sort((a, b) => a - b);
}

// Replay a stream of (assumed valid) events into final per-sensor sample maps.
export function referenceReplay(events) {
  const sensors = new Map();
  for (const ev of events) {
    if (ev.type === 'UPSERT') {
      if (!sensors.has(ev.sensorId)) sensors.set(ev.sensorId, new Map());
      sensors.get(ev.sensorId).set(ev.sampleId, { sampleId: ev.sampleId, ts: ev.ts, temp: ev.temp });
    } else if (ev.type === 'RETRACT') {
      const m = sensors.get(ev.sensorId);
      if (m) m.delete(ev.sampleId);
    }
  }
  return sensors;
}
