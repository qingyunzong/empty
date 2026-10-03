import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agv.js');

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'agv-test-'));
}

export function writeJsonl(dir, name, events) {
  mkdirSync(dir, { recursive: true });
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, name), text);
}

export function runCli(inDir, outDir, extra = []) {
  return spawnSync(process.execPath, [BIN, 'deadlock', '--in', inDir, '--out', outDir, ...extra], {
    encoding: 'utf8',
  });
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function readJsonl(file) {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
