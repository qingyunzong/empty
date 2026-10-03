import fs from 'node:fs';
import path from 'node:path';
import { PackError } from './errors.js';

export const KINDS = new Set(['vision', 'barcode', 'audit', 'retract']);
const RETRACT_TARGETS = new Set(['vision', 'barcode', 'audit']);
const HASH_RE = /^[0-9a-f]{64}$/;

function fail(code, msg) {
  throw new PackError(code, msg);
}

function need(raw, field, where) {
  if (!(field in raw) || raw[field] === undefined) {
    fail('BAD_EVENT', `${where}: missing field "${field}"`);
  }
  return raw[field];
}

function needTs(raw, where) {
  const ts = need(raw, 'eventTs', where);
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    fail('BAD_EVENT', `${where}: eventTs must be a finite number`);
  }
  return ts;
}

export function validateEvent(raw, kind, where) {
  const eventTs = needTs(raw, where);
  switch (kind) {
    case 'vision': {
      const hash = need(raw, 'hash', where);
      if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
        fail('HASH_BAD', `${where}: hash must be 64 lowercase hex chars, got ${JSON.stringify(hash)}`);
      }
      return {
        kind, eventTs,
        frame: need(raw, 'frame', where),
        sku: need(raw, 'sku', where),
        defect: raw.defect ?? null,
        hash,
        op: need(raw, 'op', where),
      };
    }
    case 'barcode':
      return {
        kind, eventTs,
        frame: need(raw, 'frame', where),
        case: need(raw, 'case', where),
        op: need(raw, 'op', where),
      };
    case 'audit': {
      const pass = need(raw, 'pass', where);
      if (typeof pass !== 'boolean') {
        fail('BAD_EVENT', `${where}: pass must be a boolean`);
      }
      return { kind, eventTs, sku: need(raw, 'sku', where), pass, op: need(raw, 'op', where) };
    }
    case 'retract': {
      const target = raw.type !== undefined ? need(raw, 'target', where) : need(raw, 'kind', where);
      if (!RETRACT_TARGETS.has(target)) {
        fail('BAD_EVENT', `${where}: retract target must be one of vision|barcode|audit`);
      }
      return { kind, eventTs, target, id: need(raw, 'id', where) };
    }
    default:
      fail('BAD_KIND', `${where}: unknown event kind ${JSON.stringify(kind)}`);
  }
}

// Reads every *.jsonl file in `inDir` (sorted by name, line order = arrival order)
// and returns [{ seq, event }] with a stable arrival index per event.
export function readEvents(inDir) {
  const files = fs.readdirSync(inDir).filter((f) => f.endsWith('.jsonl')).sort();
  const events = [];
  let seq = 0;
  for (const file of files) {
    const fileKind = path.basename(file, '.jsonl');
    const lines = fs.readFileSync(path.join(inDir, file), 'utf8').split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const where = `${file}:${idx + 1}`;
      let raw;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        fail('BAD_JSON', `${where}: invalid JSON`);
      }
      const kind = raw.type ?? (KINDS.has(fileKind) ? fileKind : raw.kind);
      if (!KINDS.has(kind)) {
        fail('BAD_KIND', `${where}: unknown event kind ${JSON.stringify(kind)}`);
      }
      events.push({ seq: seq++, event: validateEvent(raw, kind, where) });
    });
  }
  return events;
}
