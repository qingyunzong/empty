import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'custody-'));
}

export function eventsFile(dir) {
  return path.join(dir, 'events.jsonl');
}

export function readLines(dir) {
  const raw = fs.readFileSync(eventsFile(dir), 'utf8');
  return raw === '' ? [] : raw.split('\n').filter((l) => l.length > 0);
}

export function writeLines(dir, lines) {
  fs.writeFileSync(eventsFile(dir), lines.join('\n') + (lines.length ? '\n' : ''));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
