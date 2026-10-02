import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdirPath, runCli } from '../testlib/helpers.js';
import { appendToLog, readJsonl } from '../lib/store.js';
import { verify, EXIT_LOW_EPOCH } from '../lib/verify.js';

// Site exit: low-epoch backfill after exit is rejected (exit 16), history kept.
test('backfill at or below exit epoch is rejected with exit 16', () => {
  const dir = tmpdirPath();
  const log = join(dir, 'e.jsonl');
  appendToLog(log, { site: 'E', epoch: 1, type: 'step', payload: { n: 1 } });
  appendToLog(log, { site: 'E', epoch: 2, type: 'exit', payload: { reason: 'line decommissioned' } });
  // Low-epoch backfill arrives later from the offline site.
  appendToLog(log, { site: 'E', epoch: 2, type: 'step', payload: { n: 'late' } });

  assert.throws(() => verify(readJsonl(log)), (err) => err.exitCode === EXIT_LOW_EPOCH);
  const res = runCli(['verify', log]);
  assert.equal(res.status, 16, res.stderr);
  assert.match(res.stderr, /low-epoch/);
});

test('epoch decrease without exit is also rejected; higher epoch after exit is fine', () => {
  const dir = tmpdirPath();
  const bad = join(dir, 'bad.jsonl');
  appendToLog(bad, { site: 'E', epoch: 3, type: 'step', payload: {} });
  appendToLog(bad, { site: 'E', epoch: 2, type: 'step', payload: {} });
  assert.throws(() => verify(readJsonl(bad)), (err) => err.exitCode === EXIT_LOW_EPOCH);

  const good = join(dir, 'good.jsonl');
  appendToLog(good, { site: 'E', epoch: 1, type: 'step', payload: { n: 1 } });
  appendToLog(good, { site: 'E', epoch: 2, type: 'exit', payload: {} });
  appendToLog(good, { site: 'E', epoch: 3, type: 'step', payload: { n: 'rejoined at higher epoch' } });
  const cert = verify(readJsonl(good));
  assert.equal(cert.status, 'ok');
  assert.equal(cert.count, 3, 'history retained across exit');
  assert.equal(cert.sites.E.exited, true);
  assert.equal(cert.sites.E.exitEpoch, 2);
});
