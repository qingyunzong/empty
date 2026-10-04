import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CertError } from './errors.js';

export function parseTimeMs(value, ctx) {
  if (typeof value !== 'string') {
    throw new CertError('E_PARSE', `${ctx}: expected an ISO-8601 timestamp string`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new CertError('E_PARSE', `${ctx}: invalid timestamp "${value}"`);
  }
  return ms;
}

function parseJsonLines(file, ctx) {
  const records = [];
  const text = readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      throw new CertError('E_PARSE', `${ctx}: line ${idx + 1} is not valid JSON`);
    }
  });
  return records;
}

function requireNumber(value, ctx) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CertError('E_PARSE', `${ctx}: expected a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireString(value, ctx) {
  if (typeof value !== 'string' || value === '') {
    throw new CertError('E_PARSE', `${ctx}: expected a non-empty string`);
  }
  return value;
}

function loadReadings(file) {
  if (!existsSync(file)) {
    throw new CertError('E_MISSING_INPUT', `readings file not found: ${file}`);
  }
  return parseJsonLines(file, 'readings.jsonl').map((raw, i) => {
    const ctx = `readings.jsonl:${i + 1}`;
    const sensorId = requireString(raw.sensor_id, `${ctx} sensor_id`);
    const tsMs = parseTimeMs(raw.ts, `${ctx} ts`);
    const tempC = requireNumber(raw.temp_c, `${ctx} temp_c`);
    return { sensor_id: sensorId, ts: raw.ts, ts_ms: tsMs, temp_c: tempC };
  });
}

function loadShipments(file) {
  if (!existsSync(file)) {
    throw new CertError('E_MISSING_INPUT', `shipments file not found: ${file}`);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CertError('E_PARSE', `shipments.json: not valid JSON`);
  }
  const list = Array.isArray(doc) ? doc : doc.shipments;
  if (!Array.isArray(list)) {
    throw new CertError('E_PARSE', 'shipments.json: expected an array or {"shipments": [...]}');
  }
  const seen = new Set();
  return list.map((raw, i) => {
    const ctx = `shipments.json[${i}]`;
    const batchId = requireString(raw.batch_id, `${ctx} batch_id`);
    if (seen.has(batchId)) {
      throw new CertError('E_PARSE', `${ctx}: duplicate batch_id "${batchId}"`);
    }
    seen.add(batchId);
    const sensorId = requireString(raw.sensor_id, `${ctx} sensor_id`);
    const inMs = parseTimeMs(raw.in_time, `${ctx} in_time`);
    const outMs = parseTimeMs(raw.out_time, `${ctx} out_time`);
    if (outMs < inMs) {
      throw new CertError(
        'E_TIME_INVERSION',
        `${ctx}: out_time (${raw.out_time}) is before in_time (${raw.in_time}) for batch "${batchId}"`,
      );
    }
    const minTempC = raw.min_temp_c === undefined ? 2 : requireNumber(raw.min_temp_c, `${ctx} min_temp_c`);
    const maxTempC = raw.max_temp_c === undefined ? 8 : requireNumber(raw.max_temp_c, `${ctx} max_temp_c`);
    if (minTempC > maxTempC) {
      throw new CertError('E_PARSE', `${ctx}: min_temp_c > max_temp_c`);
    }
    const maxGapSeconds =
      raw.max_gap_seconds === undefined ? 300 : requireNumber(raw.max_gap_seconds, `${ctx} max_gap_seconds`);
    if (maxGapSeconds < 0) {
      throw new CertError('E_PARSE', `${ctx}: max_gap_seconds must be >= 0`);
    }
    return {
      batch_id: batchId,
      sensor_id: sensorId,
      in_time: raw.in_time,
      out_time: raw.out_time,
      in_ms: inMs,
      out_ms: outMs,
      min_temp_c: minTempC,
      max_temp_c: maxTempC,
      max_gap_seconds: maxGapSeconds,
    };
  });
}

function loadAdjustments(file, knownSensors) {
  if (!existsSync(file)) {
    return [];
  }
  const deduped = new Map();
  parseJsonLines(file, 'adjustments.jsonl').forEach((raw, i) => {
    const ctx = `adjustments.jsonl:${i + 1}`;
    const sensorId = requireString(raw.sensor_id, `${ctx} sensor_id`);
    if (!knownSensors.has(sensorId)) {
      throw new CertError(
        'E_UNKNOWN_SENSOR',
        `${ctx}: adjustment targets unknown sensor "${sensorId}"`,
      );
    }
    const startMs = parseTimeMs(raw.start, `${ctx} start`);
    const endMs = parseTimeMs(raw.end, `${ctx} end`);
    if (endMs < startMs) {
      throw new CertError(
        'E_TIME_INVERSION',
        `${ctx}: adjustment end (${raw.end}) is before start (${raw.start})`,
      );
    }
    const offsetC = requireNumber(raw.offset_c, `${ctx} offset_c`);
    // Identical adjustment events are deduplicated so replaying the same
    // adjustments file (or the same event twice) is idempotent.
    const key = `${sensorId}|${startMs}|${endMs}|${offsetC}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        sensor_id: sensorId,
        start: raw.start,
        end: raw.end,
        start_ms: startMs,
        end_ms: endMs,
        offset_c: offsetC,
      });
    }
  });
  return [...deduped.values()].sort(
    (a, b) => a.start_ms - b.start_ms || a.sensor_id.localeCompare(b.sensor_id) || a.end_ms - b.end_ms,
  );
}

export function loadInputs(inDir) {
  const readings = loadReadings(path.join(inDir, 'readings.jsonl'));
  const shipments = loadShipments(path.join(inDir, 'shipments.json'));
  const knownSensors = new Set([
    ...readings.map((r) => r.sensor_id),
    ...shipments.map((s) => s.sensor_id),
  ]);
  const adjustments = loadAdjustments(path.join(inDir, 'adjustments.jsonl'), knownSensors);
  return { readings, shipments, adjustments };
}
