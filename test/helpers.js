import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

// Drives the CLI in-process: the sandboxed test runner cannot spawn child
// processes, so we invoke the same `run(argv)` entry the executable uses and
// capture what it writes. The returned `code` is the process exit code.
export function runCli(args) {
  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    return { code: run(args), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

export function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2026-01-01T00:00:00Z');

export function randomInstance(rand) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const expiryPool = [5, 10, 20, 40].map((d) => new Date(BASE + d * DAY).toISOString());

  const materials = [];
  const materialCount = int(2, 4);
  for (let i = 0; i < materialCount; i += 1) {
    materials.push({
      id: `M${i}`,
      quantity: int(0, 20),
      expiry: pick(expiryPool),
      status: rand() < 0.15 ? 'quarantined' : 'released',
    });
  }

  const batches = [];
  const batchCount = int(1, 3);
  const lines = ['L1', 'L2'];
  const lineCursor = new Map();
  for (let i = 0; i < batchCount; i += 1) {
    const id = `P${i}`;
    const pool = [...materials.map((m) => m.id), ...batches.map((b) => b.id)];
    const shuffled = pool.filter(() => rand() < 0.6);
    const candidates = shuffled.length > 0 ? shuffled : [pool[pool.length - 1]];
    const line = pick(lines);
    const cursor = lineCursor.get(line) ?? 0;
    // Mostly non-overlapping slots, occasionally force an overlap.
    const startHour = rand() < 0.85 ? cursor : Math.max(0, cursor - 4);
    const duration = int(2, 8);
    lineCursor.set(line, startHour + duration + 1);
    batches.push({
      id,
      line,
      start: new Date(BASE + startHour * 3600000).toISOString(),
      end: new Date(BASE + (startHour + duration) * 3600000).toISOString(),
      output: int(1, 15),
      loss: int(0, 5),
      expiry: pick(expiryPool),
      candidates,
      status: rand() < 0.05 ? 'quarantined' : 'released',
    });
  }
  return { materials, batches };
}
