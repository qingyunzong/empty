import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

export function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'weather-merge-'));
}

// Drive the CLI in-process (the sandbox forbids spawning child processes).
export function run(args, { input } = {}) {
  let stdout = '';
  let stderr = '';
  const status = main(args, {
    readStdin: () => input ?? '',
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { status, stdout, stderr };
}

export function writeJsonl(dir, name, records) {
  const path = join(dir, name);
  const text = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  writeFileSync(path, text);
  return path;
}

export function register(site, origin, seq) {
  return { type: 'site', site, op: 'register', origin, seq };
}

export function remove(site, origin, seq) {
  return { type: 'site', site, op: 'delete', origin, seq };
}

export function corr(site, time, delta, origin, seq) {
  return { type: 'correction', site, time, delta, origin, seq };
}
