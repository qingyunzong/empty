import fs from 'node:fs';
import path from 'node:path';
import { createState } from './saga.js';

export function loadState(logDir) {
  const file = path.join(logDir, 'state.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return createState();
}

export function saveState(logDir, state) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'state.json'), JSON.stringify(state, null, 2));
  const lines = state.events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(logDir, 'events.jsonl'), lines ? lines + '\n' : '');
}
