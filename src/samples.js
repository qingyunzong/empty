import { InputError } from './errors.js';

// Samples JSONL format (one JSON object per line, '#' starts a comment):
//   {"type":"batch","size":100}                              optional, once
//   {"type":"sample","id":"S1","defects":0,"severity":"minor"}
//   {"type":"correction","id":"S1","defects":1,"reason":"label misread"}
//
// The initial sample lines form version 1. Every correction produces a new
// version of the sample set; earlier versions stay in the audit chain.

const SEVERITIES = new Set(['minor', 'major', 'critical']);
const SEVERITY_RANK = { minor: 1, major: 2, critical: 3 };

export function parseSamples(text, filename = '<samples>') {
  const fail = (msg, line) => {
    throw new InputError(`${filename}:${line}: ${msg}`, line);
  };

  let batchSize = null;
  const samples = new Map();
  const versions = [];
  let sawCorrection = false;

  const snapshot = () => ({
    batchSize: batchSize ?? samples.size,
    samples: [...samples.values()].map((s) => ({ ...s })),
  });

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      fail(`invalid JSON: ${trimmed.slice(0, 60)}`, line);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      fail('each line must be a JSON object', line);
    }

    switch (obj.type) {
      case 'batch': {
        if (batchSize !== null) fail("duplicate 'batch' record", line);
        if (!Number.isInteger(obj.size) || obj.size < 0) {
          fail("'batch.size' must be a non-negative integer", line);
        }
        batchSize = obj.size;
        break;
      }
      case 'sample': {
        if (sawCorrection) fail("'sample' records must precede all corrections", line);
        if (typeof obj.id !== 'string' || obj.id === '') {
          fail("'sample.id' must be a non-empty string", line);
        }
        if (samples.has(obj.id)) fail(`duplicate sample id '${obj.id}'`, line);
        const defects = obj.defects ?? 0;
        if (!Number.isInteger(defects) || defects < 0) {
          fail(`'defects' for sample '${obj.id}' must be a non-negative integer`, line);
        }
        const severity = obj.severity ?? 'minor';
        if (!SEVERITIES.has(severity)) {
          fail(`'severity' for sample '${obj.id}' must be minor|major|critical`, line);
        }
        samples.set(obj.id, { id: obj.id, defects, severity });
        break;
      }
      case 'correction': {
        if (typeof obj.id !== 'string' || !samples.has(obj.id)) {
          fail(`correction refers to unknown sample id '${obj.id}'`, line);
        }
        if (!sawCorrection) {
          versions.push(snapshot());
          sawCorrection = true;
        }
        const current = samples.get(obj.id);
        const next = { ...current };
        if ('defects' in obj) {
          if (!Number.isInteger(obj.defects) || obj.defects < 0) {
            fail(`corrected 'defects' for sample '${obj.id}' must be a non-negative integer`, line);
          }
          next.defects = obj.defects;
        }
        if ('severity' in obj) {
          if (!SEVERITIES.has(obj.severity)) {
            fail(`corrected 'severity' for sample '${obj.id}' must be minor|major|critical`, line);
          }
          next.severity = obj.severity;
        }
        samples.set(obj.id, next);
        versions.push(snapshot());
        break;
      }
      default:
        fail(`unknown record type '${obj.type}' (expected batch|sample|correction)`, line);
    }
  });

  if (!sawCorrection) versions.push(snapshot());
  return { versions };
}

// Builds the VM evaluation context for one version of the sample set:
// batch size, number of samples drawn, cumulative defects, worst severity.
export function contextFor(state) {
  let defects = 0;
  let worst = 'minor';
  for (const sample of state.samples) {
    defects += sample.defects;
    if (sample.defects > 0 && SEVERITY_RANK[sample.severity] > SEVERITY_RANK[worst]) {
      worst = sample.severity;
    }
  }
  return {
    batch_size: state.batchSize,
    sampled: state.samples.length,
    defects,
    severity: worst,
  };
}

export function canonicalState(state) {
  const sorted = [...state.samples].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    batchSize: state.batchSize,
    samples: sorted.map((s) => ({ id: s.id, defects: s.defects, severity: s.severity })),
  };
}
