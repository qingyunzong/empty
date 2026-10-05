import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

export const CONFIG = {
  species: [
    { id: 'S1', morph: 'forb' },
    { id: 'S2', morph: 'forb' },
    { id: 'G1', morph: 'graminoid' },
  ],
  plots: [
    { id: 'P1', area: 10 },
    { id: 'P2', area: 6 },
  ],
  maxTier: 5,
};

export function lines(...ops) {
  return ops.map((o) => JSON.stringify(o)).join('\n') + '\n';
}

// Drive the CLI in-process (the sandbox forbids spawning child processes);
// bin/eco-merge.js is a thin wrapper around this exact entry point.
export function runCli(args) {
  const { code, out, err } = run(args);
  return { status: code, stdout: out, stderr: err, json: safeParse(out) };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function withTempFiles(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'eco-merge-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, content);
    paths[name] = p;
  }
  return fn(paths);
}

// deterministic PRNG for the property test
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
