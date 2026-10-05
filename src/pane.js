import { toIso, round6 } from './util.js';

export function activeCalibration(calibrations, t) {
  let best = null;
  for (const calibration of calibrations) {
    if (calibration.effectiveFrom <= t && t < calibration.expireAt) {
      if (
        best === null ||
        calibration.version > best.version ||
        (calibration.version === best.version && calibration.seq > best.seq)
      ) {
        best = calibration;
      }
    }
  }
  return best;
}

export function computeSegments(start, end, calibrations) {
  const points = new Set([start, end]);
  for (const calibration of calibrations) {
    if (calibration.expireAt <= start || calibration.effectiveFrom >= end) continue;
    points.add(Math.max(start, calibration.effectiveFrom));
    points.add(Math.min(end, calibration.expireAt));
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (from >= to) continue;
    const calibration = activeCalibration(calibrations, Math.floor((from + to) / 2));
    const version = calibration ? calibration.version : null;
    const last = segments[segments.length - 1];
    if (last && last.version === version) {
      last.to = toIso(to);
    } else {
      segments.push({ from: toIso(from), to: toIso(to), version });
    }
  }
  return segments;
}

export function computePane({ sensorId, start, end, samples, calibrations }) {
  const paneSamples = samples
    .filter((sample) => sample.sensorId === sensorId && sample.ts >= start && sample.ts < end)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (paneSamples.length === 0) return null;

  const paneCalibrations = calibrations.filter(
    (calibration) =>
      calibration.sensorId === sensorId &&
      calibration.expireAt > start &&
      calibration.effectiveFrom < end,
  );

  let weightSum = 0;
  let weightedSum = 0;
  let uncalibrated = false;
  const evidence = [];

  for (let i = 0; i < paneSamples.length; i += 1) {
    const sample = paneSamples[i];
    const prevMid = i === 0 ? start : (paneSamples[i - 1].ts + sample.ts) / 2;
    const nextMid = i === paneSamples.length - 1 ? end : (sample.ts + paneSamples[i + 1].ts) / 2;
    const weight = Math.max(0, Math.min(end, nextMid) - Math.max(start, prevMid));
    const calibration = activeCalibration(paneCalibrations, sample.ts);
    const calibrated = calibration
      ? sample.value * calibration.factor + calibration.offset
      : sample.value;
    if (!calibration) uncalibrated = true;
    weightSum += weight;
    weightedSum += weight * calibrated;
    if (weight > 0) evidence.push(sample.id);
  }

  if (!(weightSum > 0) || !Number.isFinite(weightedSum)) {
    const error = new Error('weight sum anomaly while aggregating pane');
    error.code = 'MALFORMED';
    throw error;
  }

  return {
    pane: `${sensorId}@${toIso(start)}/${toIso(end)}`,
    sensorId,
    windowStart: toIso(start),
    windowEnd: toIso(end),
    weightedFlux: round6(weightedSum / weightSum),
    uncalibrated,
    segments: computeSegments(start, end, paneCalibrations),
    evidence,
  };
}
