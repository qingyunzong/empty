import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { makeDir } from './helpers.js';

test('begin/scan/adjust/close aggregates by bin+item', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  await store.scan('s1', 'A-01', 'WIP-0001', 2);
  await store.scan('s1', 'A-01', 'WIP-0001', 3);
  await store.scan('s1', 'B-02', 'WIP-0001', 4);
  await store.adjust('s1', 'A-01', 'WIP-0001', -1);
  const session = await store.close('s1');
  assert.equal(session.status, 'closed');
  assert.deepEqual(await store.stock(), {
    'A-01|WIP-0001': 4,
    'B-02|WIP-0001': 4,
  });
});

test('duplicate begin is rejected', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  await assert.rejects(store.begin('s1'), { code: 'SESSION_EXISTS', exitCode: 3 });
});

test('barcode format validation', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  for (const bad of ['wip-0001', 'WIP1', 'WIP-', 'TOOLONGGG-1', 'WIP-12']) {
    await assert.rejects(store.scan('s1', 'A-01', bad, 1), { code: 'VALIDATION', exitCode: 2 });
  }
  for (const bad of ['a-01', 'AB-01', 'A-1', 'A-011']) {
    await assert.rejects(store.scan('s1', bad, 'WIP-0001', 1), { code: 'VALIDATION', exitCode: 2 });
  }
});

test('quantity must be a positive integer for scan, non-zero integer for adjust', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  for (const bad of [1.5, 0, -2, Number.NaN, '3']) {
    await assert.rejects(store.scan('s1', 'A-01', 'WIP-0001', bad), {
      code: 'VALIDATION',
      exitCode: 2,
    });
  }
  await assert.rejects(store.adjust('s1', 'A-01', 'WIP-0001', 0), { code: 'VALIDATION' });
  await assert.rejects(store.adjust('s1', 'A-01', 'WIP-0001', 2.5), { code: 'VALIDATION' });
  await store.adjust('s1', 'A-01', 'WIP-0001', -1); // negative adjust itself is legal
});

test('scan/adjust after close report CLOSED', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  await store.scan('s1', 'A-01', 'WIP-0001', 1);
  await store.close('s1');
  await assert.rejects(store.scan('s1', 'A-01', 'WIP-0001', 1), { code: 'CLOSED', exitCode: 3 });
  await assert.rejects(store.adjust('s1', 'A-01', 'WIP-0001', 1), { code: 'CLOSED', exitCode: 3 });
  await assert.rejects(store.close('s1'), { code: 'CLOSED', exitCode: 3 });
});

test('negative inventory boundary: exact zero closes, one below fails', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.setBase('A-01', 'WIP-0001', 5);

  await store.begin('s1');
  await store.adjust('s1', 'A-01', 'WIP-0001', -5); // boundary: lands exactly on 0
  await store.close('s1');
  assert.equal((await store.stock())['A-01|WIP-0001'], 0);

  await store.begin('s2');
  await store.adjust('s2', 'A-01', 'WIP-0001', -1); // one below zero
  await assert.rejects(store.close('s2'), { code: 'NEGATIVE_INVENTORY', exitCode: 3 });
  const session = await store.session('s2');
  assert.equal(session.status, 'open', 'failed close leaves the session open');
});

test('undo only allowed for unclosed sessions', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  await store.scan('s1', 'A-01', 'WIP-0001', 2);
  await store.scan('s1', 'A-01', 'WIP-0001', 3);
  const afterUndo = await store.undo('s1');
  assert.deepEqual(afterUndo.totals, { 'A-01|WIP-0001': 2 });
  await store.close('s1');
  await assert.rejects(store.undo('s1'), { code: 'UNDO_CLOSED', exitCode: 3 });
  assert.equal((await store.stock())['A-01|WIP-0001'], 2);
});

test('undo on empty session fails', async () => {
  const store = await Store.open(await makeDir(), { nodeId: 't1' });
  await store.begin('s1');
  await assert.rejects(store.undo('s1'), { code: 'NOTHING_TO_UNDO', exitCode: 3 });
});
