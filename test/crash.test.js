import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { tmpdir, mulberry32, randomSample, refScan, TYPES } from './helpers.js';

const fixture = fileURLToPath(new URL('../fixtures/compact-crash.js', import.meta.url));

// Acceptance scenario 2: crash injected after the new compact files are
// written but before the pointer switch. Restart must lose nothing and a
// subsequent compact must succeed.
test('crash during compact (before pointer switch): no data loss, compact again works', () => {
  const dir = tmpdir();
  const rng = mulberry32(7);
  const ref = new Map();

  let store = Store.open(dir);
  for (let i = 1; i <= 800; i++) {
    const rec = randomSample(rng, `S${String(i).padStart(6, '0')}`);
    store.add(rec);
    ref.set(rec.id, rec);
  }
  store.compact(); // one successful compact first: gen-2 is now live
  store.close();
  const pointerBefore = fs.readFileSync(path.join(dir, 'POINTER'), 'utf8').trim();

  // Crash mid-compact in a separate process.
  const crashed = spawnSync(process.execPath, [fixture, dir], {
    env: { ...process.env, BIOSPEC_CRASH_BEFORE_POINTER_SWITCH: '1' },
    stdio: 'ignore',
  });
  assert.strictEqual(crashed.status, 1, 'crashed compact should exit non-zero');

  // Pointer untouched; the half-written generation is still on disk.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'POINTER'), 'utf8').trim(), pointerBefore);

  store = Store.open(dir); // must recover cleanly and discard the stale gen dir
  for (const [id, rec] of ref) assert.deepStrictEqual(store.find(id), rec);
  for (const type of TYPES) assert.deepStrictEqual(store.scanByType(type), refScan(ref, { type }));
  assert.deepStrictEqual(store.scan({}), refScan(ref, {}));
  assert.deepStrictEqual(store.scanByDateRange('2024-01-01', '2024-12-31'), refScan(ref, { from: '2024-01-01', to: '2024-12-31' }));
  assert.ok(!fs.existsSync(path.join(dir, `gen-${Number(pointerBefore) + 1}`)), 'stale gen dir cleaned up');

  // Writes still work after the crash, and compact can be retried.
  const extra = randomSample(rng, 'S009999');
  store.add(extra);
  ref.set(extra.id, extra);
  store.compact();
  assert.strictEqual(fs.readFileSync(path.join(dir, 'POINTER'), 'utf8').trim(), String(Number(pointerBefore) + 1));
  store.close();

  store = Store.open(dir);
  for (const [id, rec] of ref) assert.deepStrictEqual(store.find(id), rec);
  assert.deepStrictEqual(store.scan({}), refScan(ref, {}));
  store.close();
});
