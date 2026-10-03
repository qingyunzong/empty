import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { sync, verify, loadSettled, loadCheckpoint } from '../lib/engine.js';
import { tmpdir, writeNdjson, appendNdjson } from './helpers.js';

const WORKER = path.resolve(import.meta.dirname, 'fixtures', 'crashable-sync-worker.js');

// Acceptance 2: kill the process after the journal is durable but before the
// checkpoint is written; recovery must neither skip nor duplicate backfills.
// (The sandbox forbids spawning child processes, so the "process" is a worker
// thread that is hard-terminated via worker.terminate() at the crash window.)
test('kill before checkpoint write recovers without skipping or duplicating backfills', async () => {
  const dir = tmpdir();
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');
  const base = 1_700_000_000_000;

  writeNdjson(rulesPath, [
    { op: 'add', ruleId: 'std', validFrom: 0, validTo: null, rateBps: 100, priority: 1 },
  ]);

  const firstBatch = [];
  for (let i = 0; i < 50; i++) {
    firstBatch.push({ txId: `tx-${i}`, time: base + i * 1000, amount: 10_000 });
  }
  writeNdjson(txPath, firstBatch);
  const first = sync({ rulesPath, txPath, stateDir });
  assert.equal(first.settledCount, 50);
  assert.equal(first.appended, 50);
  const checkpointBefore = loadCheckpoint(stateDir);

  // Second batch: new txs plus backfilled corrections into the settled range.
  const secondBatch = [];
  for (let i = 50; i < 90; i++) {
    secondBatch.push({ txId: `tx-${i}`, time: base + i * 1000, amount: 20_000 });
  }
  secondBatch.push({ txId: 'tx-3', time: base + 3000, amount: 99_900, backfill: true });
  secondBatch.push({ txId: 'tx-7', time: base + 7000, amount: 55_500, backfill: true });
  secondBatch.push({ txId: 'tx-late', time: base + 1500, amount: 7_700, backfill: true });
  appendNdjson(txPath, secondBatch);

  // Kill the worker after the journal is fsynced, before the checkpoint write.
  const worker = new Worker(WORKER, { workerData: { rulesPath, txPath, stateDir } });
  const [message] = await once(worker, 'message');
  assert.equal(message, 'journal-durable');
  await worker.terminate();

  // Checkpoint must be untouched (still points at the first batch).
  const checkpointAfterCrash = loadCheckpoint(stateDir);
  assert.deepEqual(checkpointAfterCrash, checkpointBefore);

  // Journal already holds the second batch once (43 lines appended).
  const afterCrash = loadSettled(stateDir);
  assert.equal(afterCrash.journalLines, 50 + secondBatch.length);
  assert.equal(afterCrash.settled.size, 91); // corrections already visible

  // Recovery: re-sync replays the same lines; identical records are skipped,
  // so the journal stays exactly-once and no transaction is duplicated.
  const recovered = sync({ stateDir });
  assert.equal(recovered.consumed, secondBatch.length);
  assert.equal(recovered.appended, 0);
  assert.equal(recovered.replayed, secondBatch.length);
  assert.equal(recovered.settledCount, 91);

  const afterRecovery = loadSettled(stateDir);
  assert.equal(afterRecovery.journalLines, 50 + secondBatch.length);
  assert.equal(afterRecovery.settled.size, 91);

  // No transaction skipped, no duplicate txId, corrections applied exactly once.
  const ids = [...afterRecovery.settled.keys()];
  assert.equal(new Set(ids).size, ids.length);
  for (let i = 0; i < 90; i++) assert.ok(afterRecovery.settled.has(`tx-${i}`), `missing tx-${i}`);
  assert.ok(afterRecovery.settled.has('tx-late'));
  assert.equal(afterRecovery.settled.get('tx-3').fee, 999); // 99_900 * 100bps
  assert.equal(afterRecovery.settled.get('tx-7').fee, 555);
  assert.equal(afterRecovery.settled.get('tx-late').fee, 77);

  // State after kill+recovery must equal a clean single-pass run.
  const cleanDir = path.join(dir, 'clean-state');
  sync({ rulesPath, txPath, stateDir: cleanDir });
  const clean = loadSettled(cleanDir);
  const strip = (m) => [...m.values()].map(({ seq, ...rest }) => rest).sort((a, b) => (a.txId < b.txId ? -1 : 1));
  assert.deepEqual(strip(afterRecovery.settled), strip(clean.settled));

  const v = verify({ stateDir });
  assert.equal(v.match, true);
  assert.equal(v.count, 91);
});
