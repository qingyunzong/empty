import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/app.js';
import { SimulatedCrash } from '../src/errors.js';

export const EXAMPLE_JE = path.resolve(import.meta.dirname, '../examples/batch.je');
export const EXAMPLE_EVENTS = path.resolve(import.meta.dirname, '../examples/events.json');

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'je-test-'));
}

// Runs the CLI in-process (the sandbox forbids spawning children). Crash
// simulation uses JE_CRASH_MODE=throw, which is equivalent to a kill: every
// store write is synchronous, so the on-disk state at the throw point is
// exactly what a killed process would leave behind.
export function runJe(args, { env = {} } = {}) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  let stdout = '';
  let stderr = '';
  let code = 0;
  let crash = null;
  try {
    code = main(args, { out: (s) => { stdout += s; }, err: (s) => { stderr += s; } });
  } catch (err) {
    if (err instanceof SimulatedCrash) crash = err;
    else throw err;
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return { code, stdout, stderr, crash };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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
