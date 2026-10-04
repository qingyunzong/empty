import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ParamRegistry } from '../src/registry.js';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'param-sync-test-'));
}

export function makeRegistry(extra = []) {
  return new ParamRegistry([
    { key: 'temp', type: 'number', min: 0, max: 100, safetyCritical: true },
    { key: 'pressure', type: 'number', min: 0, max: 10, safetyCritical: true, interlock: 'temp < 50 || pressure > 2' },
    { key: 'boost', type: 'boolean' },
    { key: 'label', type: 'string' },
    ...extra,
  ]);
}

export const SAFE_MANIFEST = { values: { temp: 25, pressure: 5 } };
