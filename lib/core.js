'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CertError, parseTs, hashObject } = require('./util');

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (err) {
      throw new CertError(`${path.basename(file)}:${idx + 1}: invalid JSON: ${err.message}`);
    }
  });
  return rows;
}

function loadInputs(dir) {
  const readingsFile = path.join(dir, 'readings.jsonl');
  const shipmentsFile = path.join(dir, 'shipments.json');
  const adjustmentsFile = path.join(dir, 'adjustments.jsonl');
  for (const f of [readingsFile, shipmentsFile]) {
    if (!fs.existsSync(f)) throw new CertError(`missing input file: ${f}`);
  }

  const readings = readJsonl(readingsFile).map((row, i) => {
    if (typeof row.sensor_id !== 'string' || row.sensor_id === '') {
      throw new CertError(`readings.jsonl:${i + 1}: missing sensor_id`);
    }
    if (typeof row.temp_c !== 'number' || !Number.isFinite(row.temp_c)) {
      throw new CertError(`readings.jsonl:${i + 1}: invalid temp_c`);
    }
    return { sensor_id: row.sensor_id, ts: parseTs(row.ts, `readings.jsonl:${i + 1} ts`), temp_c: row.temp_c };
  });

  let shipmentsRaw;
  try {
    shipmentsRaw = JSON.parse(fs.readFileSync(shipmentsFile, 'utf8'));
  } catch (err) {
    throw new CertError(`shipments.json: invalid JSON: ${err.message}`);
  }
  if (!Array.isArray(shipmentsRaw)) throw new CertError('shipments.json: expected a JSON array');
  const shipments = shipmentsRaw.map((row, i) => {
    for (const key of ['shipment_id', 'batch_id', 'sensor_id']) {
      if (typeof row[key] !== 'string' || row[key] === '') throw new CertError(`shipments.json[${i}]: missing ${key}`);
    }
    for (const key of ['min_c', 'max_c', 'max_gap_s']) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key])) throw new CertError(`shipments.json[${i}]: invalid ${key}`);
    }
    const inTs = parseTs(row.in_ts, `shipments.json[${i}] in_ts`);
    const outTs = parseTs(row.out_ts, `shipments.json[${i}] out_ts`);
    if (outTs < inTs) {
      throw new CertError(`time inversion: shipment ${row.shipment_id} out_ts < in_ts`);
    }
    if (row.max_c < row.min_c) throw new CertError(`shipments.json[${i}]: max_c < min_c`);
    if (row.max_gap_s < 0) throw new CertError(`shipments.json[${i}]: negative max_gap_s`);
    return {
      shipment_id: row.shipment_id,
      batch_id: row.batch_id,
      sensor_id: row.sensor_id,
      in_ts: inTs,
      out_ts: outTs,
      min_c: row.min_c,
      max_c: row.max_c,
      max_gap_s: row.max_gap_s,
    };
  });

  const adjustments = fs.existsSync(adjustmentsFile)
    ? readJsonl(adjustmentsFile).map((row, i) => {
        if (typeof row.sensor_id !== 'string' || row.sensor_id === '') {
          throw new CertError(`adjustments.jsonl:${i + 1}: missing sensor_id`);
        }
        if (typeof row.offset_c !== 'number' || !Number.isFinite(row.offset_c)) {
          throw new CertError(`adjustments.jsonl:${i + 1}: invalid offset_c`);
        }
        const startTs = parseTs(row.start_ts, `adjustments.jsonl:${i + 1} start_ts`);
        const endTs = parseTs(row.end_ts, `adjustments.jsonl:${i + 1} end_ts`);
        if (endTs < startTs) {
          throw new CertError(`time inversion: adjustment for sensor ${row.sensor_id} has end_ts < start_ts`);
        }
        return { sensor_id: row.sensor_id, start_ts: startTs, end_ts: endTs, offset_c: row.offset_c };
      })
    : [];

  return { readings, shipments, adjustments };
}

// Deduplicate identical adjustments so replaying the same adjustments file is
// a no-op. Returns a new, canonically sorted list; input order is irrelevant.
function normalizeAdjustments(adjustments) {
  const seen = new Map();
  for (const adj of adjustments) {
    const key = `${adj.sensor_id}${adj.start_ts}${adj.end_ts}${adj.offset_c}`;
    if (!seen.has(key)) seen.set(key, adj);
  }
  return [...seen.values()].sort(
    (a, b) =>
      a.sensor_id.localeCompare(b.sensor_id) ||
      a.start_ts - b.start_ts ||
      a.end_ts - b.end_ts ||
      a.offset_c - b.offset_c
  );
}

function validateAdjustmentSensors(adjustments, knownSensorIds) {
  for (const adj of adjustments) {
    if (!knownSensorIds.has(adj.sensor_id)) {
      throw new CertError(`adjustment references unknown sensor: ${adj.sensor_id}`);
    }
  }
}

// Raw readings are never mutated; calibration produces a derived view.
function adjustedTemp(reading, adjustmentsForSensor) {
  let temp = reading.temp_c;
  for (const adj of adjustmentsForSensor) {
    if (reading.ts >= adj.start_ts && reading.ts <= adj.end_ts) temp += adj.offset_c;
  }
  return temp;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Evaluate one shipment window. Temperature is a step function: a reading
// holds until the next reading. An interval wider than max_gap_s is UNKNOWN
// and never counts as an excursion.
function evaluateShipment(shipment, sensorReadings, adjustmentsForSensor) {
  const inWindow = sensorReadings
    .filter((r) => r.ts >= shipment.in_ts && r.ts <= shipment.out_ts)
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ ts: r.ts, temp_c: adjustedTemp(r, adjustmentsForSensor) }));

  const segments = [];
  const pushSegment = (start, end, status) => {
    if (end > start) segments.push({ start_ts: start, end_ts: end, status });
  };

  let excursionSeconds = 0;
  let unknownSeconds = 0;
  let compliantSeconds = 0;

  const classify = (start, end, temp) => {
    const duration = end - start;
    if (duration <= 0) return;
    if (temp === null) {
      unknownSeconds += duration;
      pushSegment(start, end, 'UNKNOWN');
    } else if (temp < shipment.min_c || temp > shipment.max_c) {
      excursionSeconds += duration;
      pushSegment(start, end, 'EXCURSION');
    } else {
      compliantSeconds += duration;
      pushSegment(start, end, 'COMPLIANT');
    }
  };

  if (inWindow.length === 0) {
    classify(shipment.in_ts, shipment.out_ts, null);
  } else {
    const first = inWindow[0];
    classify(shipment.in_ts, Math.min(first.ts, shipment.out_ts), first.ts - shipment.in_ts <= shipment.max_gap_s ? first.temp_c : null);
    for (let i = 0; i < inWindow.length; i++) {
      const current = inWindow[i];
      const nextTs = i + 1 < inWindow.length ? inWindow[i + 1].ts : shipment.out_ts;
      const end = Math.min(nextTs, shipment.out_ts);
      classify(current.ts, end, nextTs - current.ts <= shipment.max_gap_s ? current.temp_c : null);
    }
  }

  let verdict;
  if (unknownSeconds > 0) verdict = 'UNKNOWN';
  else if (excursionSeconds > 0) verdict = 'EXCURSION';
  else verdict = 'COMPLIANT';

  return {
    verdict,
    excursion_seconds: excursionSeconds,
    unknown_seconds: unknownSeconds,
    compliant_seconds: compliantSeconds,
    readings_count: inWindow.length,
    segments,
  };
}

function adjustmentsDigest(adjustmentsForSensor) {
  return hashObject(adjustmentsForSensor.map((a) => ({
    sensor_id: a.sensor_id,
    start_ts: a.start_ts,
    end_ts: a.end_ts,
    offset_c: a.offset_c,
  })));
}

function evaluateAll(inputs) {
  const adjustments = normalizeAdjustments(inputs.adjustments);
  const knownSensors = new Set([
    ...inputs.readings.map((r) => r.sensor_id),
    ...inputs.shipments.map((s) => s.sensor_id),
  ]);
  validateAdjustmentSensors(adjustments, knownSensors);

  const readingsBySensor = groupBy(inputs.readings, (r) => r.sensor_id);
  const adjustmentsBySensor = groupBy(adjustments, (a) => a.sensor_id);

  return inputs.shipments.map((shipment) => {
    const sensorReadings = readingsBySensor.get(shipment.sensor_id) || [];
    const sensorAdjustments = adjustmentsBySensor.get(shipment.sensor_id) || [];
    const result = evaluateShipment(shipment, sensorReadings, sensorAdjustments);
    return { shipment, result, adjustments_digest: adjustmentsDigest(sensorAdjustments) };
  });
}

module.exports = {
  loadInputs,
  normalizeAdjustments,
  adjustedTemp,
  evaluateShipment,
  evaluateAll,
  adjustmentsDigest,
};
