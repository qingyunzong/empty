import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FeeError, ERR_INVALID_INPUT } from './errors.js';

// Times are epoch milliseconds internally. Inputs may be numbers or ISO-8601 strings.
export function parseTime(value, what = 'time') {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  throw new FeeError(ERR_INVALID_INPUT, `invalid ${what}: ${JSON.stringify(value)}`);
}

export function readNdjson(path) {
  if (!fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new FeeError(ERR_INVALID_INPUT, `invalid JSON at ${path}:${i + 1}`);
    }
  }
  return out;
}

export function appendLinesFsync(path, lines) {
  if (lines.length === 0) return;
  const fd = fs.openSync(path, 'a');
  try {
    fs.writeSync(fd, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, path);
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}
