import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { LedgerError } from './ledger.js';

export function loadEvents(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new LedgerError('STORE_ERROR', `corrupt JSONL at ${path}:${i + 1}`);
    }
  }
  return events;
}

export function appendEvents(path, events) {
  if (events.length === 0) return;
  const start = loadEvents(path).length;
  const lines = events
    .map((event, i) => JSON.stringify({ seq: start + i + 1, ...event }))
    .join('\n');
  appendFileSync(path, lines + '\n', 'utf8');
}
