// JSON snapshot + append-only journal persisted under a log directory,
// so each CLI invocation resumes the engine from durable state.
import fs from 'node:fs';
import path from 'node:path';

export function loadState(logDir) {
  const file = path.join(logDir, 'state.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function saveState(logDir, state, event) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'state.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
  fs.appendFileSync(
    path.join(logDir, 'journal.log'),
    JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
  );
}
