import { SampleDataError } from './errors.js';
import { hashObject } from './hash.js';
import { LEVEL_ORDER } from './checker.js';

// samples.jsonl format, one JSON object per line:
//   {"type":"batch","id":"B-2024-0001","size":1200}   (exactly one, required)
//   {"type":"sample","id":"s001","defects":2,"level":"major"}
// "type" defaults to "sample"; "defects" defaults to 0; "level" defaults to "minor".
export function parseSamples(text, sourceName = 'samples.jsonl') {
  const lines = text.split(/\r?\n/);
  let batch = null;
  const samples = [];
  const seen = new Set();
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx].trim();
    if (raw === '') continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      throw new SampleDataError(`invalid JSON: ${err.message}`, { line: lineNo, source: sourceName });
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new SampleDataError('each line must be a JSON object', { line: lineNo, source: sourceName });
    }
    const type = obj.type ?? 'sample';
    if (type === 'batch') {
      if (batch) throw new SampleDataError('duplicate batch record', { line: lineNo, source: sourceName });
      if (typeof obj.id !== 'string' || obj.id === '') {
        throw new SampleDataError('batch record requires a non-empty string "id"', { line: lineNo, source: sourceName });
      }
      if (!Number.isInteger(obj.size) || obj.size < 0) {
        throw new SampleDataError('batch record requires a non-negative integer "size"', { line: lineNo, source: sourceName });
      }
      batch = { id: obj.id, size: obj.size };
      continue;
    }
    if (type !== 'sample') {
      throw new SampleDataError(`unknown record type '${type}'`, { line: lineNo, source: sourceName });
    }
    if (typeof obj.id !== 'string' || obj.id === '') {
      throw new SampleDataError('sample record requires a non-empty string "id"', { line: lineNo, source: sourceName });
    }
    if (seen.has(obj.id)) {
      throw new SampleDataError(`duplicate sample id '${obj.id}'`, { line: lineNo, source: sourceName });
    }
    seen.add(obj.id);
    const defects = obj.defects ?? 0;
    if (!Number.isInteger(defects) || defects < 0) {
      throw new SampleDataError(`sample '${obj.id}': "defects" must be a non-negative integer`, { line: lineNo, source: sourceName });
    }
    const level = obj.level ?? 'minor';
    if (!(level in LEVEL_ORDER) || level === 'none') {
      throw new SampleDataError(`sample '${obj.id}': "level" must be minor|major|critical`, { line: lineNo, source: sourceName });
    }
    samples.push({ id: obj.id, defects, level });
  }
  if (!batch) {
    throw new SampleDataError('missing batch record: expected a line {"type":"batch","id":...,"size":...}', { line: 1, source: sourceName });
  }
  return { batch, samples };
}

// Aggregates a parsed sample set into VM inputs.
export function aggregate(parsed) {
  let defects = 0;
  let worst = 'none';
  for (const s of parsed.samples) {
    defects += s.defects;
    if (s.defects > 0 && LEVEL_ORDER[s.level] > LEVEL_ORDER[worst]) worst = s.level;
  }
  return {
    batch_size: parsed.batch.size,
    sampled: parsed.samples.length,
    defects,
    worst,
  };
}

// Canonical, order-independent hash of a sample set (binds a certificate
// to exactly this batch + sample contents).
export function sampleSetHash(parsed) {
  const sorted = [...parsed.samples].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return hashObject({ batch: parsed.batch, samples: sorted });
}
