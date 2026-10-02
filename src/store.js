import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export function loadEvents(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function appendEvent(path, event) {
  appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
}
