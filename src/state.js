import fs from 'node:fs';
import path from 'node:path';

export function loadState(file) {
  if (!file || !fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    typeof parsed !== 'object' || parsed === null
    || !Number.isInteger(parsed.committed)
    || !Array.isArray(parsed.results)
    || !Array.isArray(parsed.batches)
  ) {
    throw new Error(`Invalid state file: ${file}`);
  }
  return parsed;
}

// Atomic write: serialize to a temp file, then rename over the target so a
// crash mid-write can never leave a half-written state file behind.
export function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function committedBoundaryOf(file) {
  const state = loadState(file);
  return state ? state.committed : 0;
}

export function resolvePath(p) {
  return path.resolve(process.cwd(), p);
}
