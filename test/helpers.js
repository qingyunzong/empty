import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicy, loadStock, parseEvents } from '../src/model.js';
import { runBatch } from '../src/decide.js';
import { main } from '../src/cli.js';

export function basePolicy(overrides = {}) {
  return {
    currencies: ['CNY', 'USD', 'EUR'],
    categories: {
      electronics: { severity: 'major' },
      apparel: { severity: 'minor' },
      pharma: { severity: 'critical' },
    },
    defaultSeverity: 'minor',
    rework: {
      allowedSeverities: ['minor', 'major'],
      costPerUnit: { amount: 10, currency: 'CNY' },
      shiftBudget: { amount: 100, currency: 'CNY' },
    },
    concession: { amountThreshold: 500, blacklist: ['CUST-BAD'] },
    ...overrides,
  };
}

export function baseStock(overrides) {
  return {
    items: [
      { sku: 'SKU-E', category: 'electronics', onHand: 5 },
      { sku: 'SKU-A', category: 'apparel', onHand: 5 },
      { sku: 'SKU-P', category: 'pharma', onHand: 5 },
      ...(overrides ?? []),
    ],
  };
}

export function batch(policyObj, stockObj, events) {
  return runBatch(loadPolicy(policyObj), loadStock(stockObj), parseEvents(
    events.map((e) => JSON.stringify(e)).join('\n'),
  ));
}

// Runs the CLI in-process (the sandbox forbids child processes). `files` maps
// fixture names to contents; any CLI argument equal to a fixture name (or an
// entry in `outputs`) is resolved inside a fresh temp directory.
export function runCli(files, args, outputs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rework-line-'));
  const paths = {};
  for (const [name, content] of Object.entries(files)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], content);
  }
  for (const name of outputs) paths[name] = join(dir, name);
  const argv = args.map((a) => paths[a] ?? a);
  let stdout = '';
  let stderr = '';
  const status = main(argv, { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { status, stdout, stderr, paths, dir };
}

// Deterministic PRNG (mulberry32) for reproducible property tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
