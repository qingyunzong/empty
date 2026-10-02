import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileSchema } from './schema.js';
import { PersistentStore, FAULT_POINTS } from './persist.js';
import { FaultInjected } from './errors.js';

// Reference model (independent of the storage engine): for n safety-critical
// params whose safe value is 0, recovery after ANY crash scenario must
// converge to the all-safe state.
export function referenceSafeState(n) {
  const out = {};
  for (let i = 0; i < n; i += 1) out[`k${i}`] = 0;
  return out;
}

export function makeSafetySchema(n) {
  const defs = [];
  for (let i = 0; i < n; i += 1) {
    defs.push({ key: `k${i}`, type: 'number', min: 0, max: 10, safety: true });
  }
  return compileSchema(defs);
}

// Simulate one crash scenario: apply dangerous value 9 to every key in
// `subset`, injecting a crash at `faultPoint`, then recover.
export function simulateScenario(n, subset, faultPoint, baseDir) {
  const schema = makeSafetySchema(n);
  const dir = fs.mkdtempSync(path.join(baseDir, `sc-${n}-`));
  const safeEntries = {};
  for (let i = 0; i < n; i += 1) safeEntries[`k${i}`] = 0;
  try {
    const ps = new PersistentStore(dir, schema, 'sim', { fault: faultPoint });
    ps.commitSafeSet(safeEntries);
    for (const i of subset) ps.set(`k${i}`, 9);
    ps.commitSnapshot();
  } catch (e) {
    if (!(e instanceof FaultInjected)) throw e;
  }
  const { store, report } = PersistentStore.recover(dir, schema, 'sim');
  const state = {};
  for (let i = 0; i < n; i += 1) state[`k${i}`] = store.store.get(`k${i}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return { state, report };
}

// Enumerate every (subset, fault point) scenario for n params and compare
// recovered states against the reference safe state. n must be <= 7.
export function enumerateSafeConvergence(n) {
  if (!Number.isInteger(n) || n < 1 || n > 7) {
    throw new Error('enumerateSafeConvergence: n must be an integer in 1..7');
  }
  const expected = referenceSafeState(n);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'param-sync-enum-'));
  const failures = [];
  let scenarios = 0;
  try {
    const keys = Array.from({ length: n }, (_, i) => i);
    for (let mask = 0; mask < (1 << n); mask += 1) {
      const subset = keys.filter((i) => mask & (1 << i));
      for (const faultPoint of FAULT_POINTS) {
        scenarios += 1;
        const { state } = simulateScenario(n, subset, faultPoint, baseDir);
        if (JSON.stringify(state) !== JSON.stringify(expected)) {
          failures.push({ n, subset, faultPoint, state, expected });
        }
      }
    }
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  return { n, scenarios, converged: failures.length === 0, failures };
}
