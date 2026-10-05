import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

export function runCli(args, input) {
  let stdout = '';
  let stderr = '';
  const code = run(args, {
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
    stdin: () => input ?? '',
  });
  return { code, stdout, stderr };
}

export function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-life-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
