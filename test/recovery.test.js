import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store } from '../src/store.js';
import { CrashError } from '../src/errors.js';
import { pathExists, readJson } from '../src/storage.js';
import { makeDir } from './helpers.js';

test('fault 1: crash before scan is persisted -> scan is lost, rescan works', async () => {
  const dir = await makeDir();
  const crashing = await Store.open(dir, { nodeId: 't1', faults: ['beforeScanAppend'] });
  await crashing.begin('s1');
  await assert.rejects(crashing.scan('s1', 'A-01', 'WIP-0001', 3), CrashError);

  // nothing reached disk: no WAL, session snapshot still empty
  assert.equal(await pathExists(path.join(dir, 'scanlog.jsonl')), false);

  const store = await Store.open(dir, { nodeId: 't1' });
  const report = await store.resume();
  assert.deepEqual(report.replayed, {});
  assert.equal((await store.session('s1')).appliedSeq, 0);

  await store.scan('s1', 'A-01', 'WIP-0001', 3); // rescan
  await store.close('s1');
  assert.equal((await store.stock())['A-01|WIP-0001'], 3);
});

test('fault 2: crash before session tmp rename -> tmp discarded, WAL replayed once', async () => {
  const dir = await makeDir();
  const setup = await Store.open(dir, { nodeId: 't1' });
  await setup.begin('s1');
  const crashing = await Store.open(dir, { nodeId: 't1', faults: ['beforeSessionRename'] });
  await assert.rejects(crashing.scan('s1', 'A-01', 'WIP-0001', 3), CrashError);

  // tmp file exists, committed snapshot does not have the scan
  const tmpFile = path.join(dir, 'sessions', 's1.json.tmp');
  assert.equal(await pathExists(tmpFile), true);
  assert.equal((await readJson(path.join(dir, 'sessions', 's1.json'))).appliedSeq, 0);

  const store = await Store.open(dir, { nodeId: 't1' });
  const report = await store.resume();
  assert.ok(report.discardedTmp.includes('s1.json.tmp'), 'temp session discarded');
  assert.equal(report.replayed.s1, 1, 'WAL entry replayed');
  assert.equal(report.cursor.s1, 1, 'cursor advanced to processed offset');
  assert.equal(await pathExists(tmpFile), false);

  const session = await store.session('s1');
  assert.deepEqual(session.totals, { 'A-01|WIP-0001': 3 });

  await store.scan('s1', 'A-01', 'WIP-0001', 2); // no double-apply of the replayed scan
  await store.close('s1');
  assert.equal((await store.stock())['A-01|WIP-0001'], 5);
});

test('fault 3: crash after ledger commit -> ledger kept, close finalized once', async () => {
  const dir = await makeDir();
  const crashing = await Store.open(dir, { nodeId: 't1', faults: ['afterLedgerCommit'] });
  await crashing.begin('s1');
  await crashing.scan('s1', 'A-01', 'WIP-0001', 4);
  await assert.rejects(crashing.close('s1'), CrashError);

  // ledger already committed; session file still says open
  assert.equal((await readJson(path.join(dir, 'ledger.json'))).deltas['A-01|WIP-0001'].t1.delta, 4);
  assert.equal((await readJson(path.join(dir, 'sessions', 's1.json'))).status, 'open');

  const store = await Store.open(dir, { nodeId: 't1' });
  const report = await store.resume();
  assert.deepEqual(report.finalized, ['s1'], 'open session finalized from committed ledger');
  assert.equal((await store.session('s1')).status, 'closed');

  const ledger = await store.ledger();
  assert.equal(ledger.history.length, 1, 'commit applied exactly once');
  assert.equal((await store.stock())['A-01|WIP-0001'], 4);

  await assert.rejects(store.close('s1'), { code: 'CLOSED' });
  assert.equal((await store.verify()).ok, true);
});

test('resume is idempotent', async () => {
  const dir = await makeDir();
  const setup = await Store.open(dir, { nodeId: 't1' });
  await setup.begin('s1');
  const crashing = await Store.open(dir, {
    nodeId: 't1',
    faults: ['beforeSessionRename'],
  });
  await assert.rejects(crashing.scan('s1', 'A-01', 'WIP-0001', 3), CrashError);

  const store = await Store.open(dir, { nodeId: 't1' });
  await store.resume();
  const second = await store.resume();
  assert.deepEqual(second.replayed, {});
  assert.deepEqual(second.discardedTmp, []);
  assert.deepEqual((await store.session('s1')).totals, { 'A-01|WIP-0001': 3 });
});

test('cursor tracks the processed WAL offset across scans', async () => {
  const dir = await makeDir();
  const store = await Store.open(dir, { nodeId: 't1' });
  await store.begin('s1');
  await store.scan('s1', 'A-01', 'WIP-0001', 1);
  await store.scan('s1', 'A-01', 'WIP-0001', 2);
  await store.undo('s1');
  const cursor = JSON.parse(await readFile(path.join(dir, 'cursor.json'), 'utf8'));
  assert.equal(cursor.applied.s1, 3);
  assert.deepEqual((await store.session('s1')).totals, { 'A-01|WIP-0001': 1 });
});
