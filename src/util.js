import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function fsyncFile(path) {
  const fd = fs.openSync(path, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
