import fs from 'node:fs';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export function normalizeTokens(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function padNum(n, width) {
  return String(n).padStart(width, '0');
}

export function compareEventIds(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
