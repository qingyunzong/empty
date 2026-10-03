import fs from 'node:fs';
import { canon, sha256, fsyncFile } from './util.js';
import { recovery } from './errors.js';

export function logHash(entries) {
  return sha256(canon(entries));
}

export function makeEntry(node, clock, change, prev) {
  const base = { seq: clock[node] ?? 0, node, clock, ...structuredClone(change), prev: prev ?? null };
  return { ...base, hash: sha256(canon(base)) };
}

export function readLog(path) {
  if (!fs.existsSync(path)) return { entries: [], truncated: false, validBytes: 0 };
  const buf = fs.readFileSync(path);
  if (buf.length === 0) return { entries: [], truncated: false, validBytes: 0 };
  const torn = buf[buf.length - 1] !== 0x0a;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  let validBytes = buf.length;
  if (torn) {
    const last = lines.pop();
    validBytes = buf.length - Buffer.byteLength(last, 'utf8');
  } else {
    lines.pop();
  }
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch {
      throw recovery(`log corrupt at line ${i + 1}`, { line: i + 1 });
    }
  }
  return { entries, truncated: torn, validBytes };
}

export function appendEntry(path, entry) {
  fs.appendFileSync(path, JSON.stringify(entry) + '\n');
  fsyncFile(path);
}

export function truncateLog(path, bytes) {
  fs.truncateSync(path, bytes);
  fsyncFile(path);
}
