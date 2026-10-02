import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrderStore } from '../src/store.js';
import { sha256 } from '../testutil/helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oes-manifest-'));
}

async function seedStore(dir) {
  const store = await OrderStore.open(dir);
  store.addEvent({ id: 'e1', tradeId: 'T1', fee: 25, refundBudget: 100, text: 'red apple pie', state: 'open' });
  store.addEvent({ id: 'e2', tradeId: 'T1', fee: 15, refundBudget: 100, text: 'green apple tart', state: 'open' });
  store.addEvent({ id: 'e3', tradeId: 'T2', fee: 40, refundBudget: 50, text: 'blue berry cake', state: 'open' });
  store.undoTrade('T2');
  await store.delete('e1');
  await store.close();
  return OrderStore.open(dir);
}

test('half-written manifest on restart falls back to old segments, state intact', async () => {
  const dir = tmpdir();
  const before = await seedStore(dir);
  const expectedReport = before.report();
  const expectedPhrase = before.phraseQuery('apple');
  await before.close();

  // Simulate a crash that leaves a torn manifest behind.
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":1,"segments":["seg-000');

  const recovered = await OrderStore.open(dir);
  assert.deepEqual(recovered.report(), expectedReport, 'report must match pre-crash state');
  assert.deepEqual(recovered.phraseQuery('apple'), expectedPhrase);
  assert.deepEqual(recovered.phraseQuery('red apple'), [], 'deleted event stays deleted');
  assert.deepEqual(recovered.phraseQuery('green apple'), ['e2']);
  // Refund of T2 is still effective: remaining budget reflects it.
  assert.equal(recovered.report().trades.T2.budgetRemaining, 10);
  await recovered.close();
});

test('missing manifest falls back to backup, then to segment scan', async () => {
  const dir = tmpdir();
  const store = await seedStore(dir);
  const expectedReport = store.report();
  await store.close();

  fs.rmSync(path.join(dir, 'manifest.json'));
  let recovered = await OrderStore.open(dir);
  assert.deepEqual(recovered.report(), expectedReport, 'backup manifest recovers state');
  await recovered.close();

  fs.rmSync(path.join(dir, 'manifest.json'));
  fs.rmSync(path.join(dir, 'manifest.json.bak'));
  recovered = await OrderStore.open(dir);
  assert.deepEqual(recovered.report(), expectedReport, 'segment scan recovers state');
  await recovered.close();
});

test('crash during merge commit keeps exactly one consistent generation', async () => {
  const dir = tmpdir();
  const store = await seedStore(dir);
  const expectedReport = store.report();
  const expectedHash = sha256(store.phraseQuery('apple'));
  await store.close();

  // Run a real merge, then simulate a crash mid-commit: new segment exists,
  // tmp manifest half-written, committed manifest untouched.
  const merged = await OrderStore.open(dir);
  await merged.merge();
  await merged.close();
  const segFiles = fs.readdirSync(dir).filter((f) => f.startsWith('seg-'));
  assert.equal(segFiles.length, 1);
  fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{"version":1,"seg');

  const recovered = await OrderStore.open(dir);
  assert.deepEqual(recovered.report(), expectedReport);
  assert.equal(sha256(recovered.phraseQuery('apple')), expectedHash);
  await recovered.close();
});
