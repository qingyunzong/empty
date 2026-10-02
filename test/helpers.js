import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSafe } from '../bin/clearing.js';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clearing-'));
}

export function runCli(args) {
  const r = runSafe(args);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function writeScenario(dir, scenario) {
  const file = path.join(dir, 'scenario-input.json');
  fs.writeFileSync(file, JSON.stringify(scenario, null, 2));
  return file;
}
