import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

export function tmpdirPath(prefix = 'ebr-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Deterministic PRNG so failures are reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
