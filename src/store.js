import { readFileSync, appendFileSync, existsSync } from 'node:fs';

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function appendJsonl(path, rawEvents) {
  if (rawEvents.length === 0) return;
  const lines = rawEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(path, lines, 'utf8');
}
