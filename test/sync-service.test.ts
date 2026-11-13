import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCursor } from '../src/cursor.ts';
import { SyncService } from '../src/sync-service.ts';

function seedService(count: number): SyncService<string> {
  const service = new SyncService<string>();
  for (let i = 0; i < count; i += 1) {
    service.upsert(`k${String(i).padStart(2, '0')}`, `value-${i}`);
  }
  return service;
}

test('paginates in key order with Relay pageInfo', () => {
  const service = seedService(5);
  const page1 = service.fetchConnection(null, 2);
  assert.deepEqual(page1.edges.map((e) => e.node.id), ['k00', 'k01']);
  assert.equal(page1.pageInfo.hasNextPage, true);
  assert.equal(page1.pageInfo.hasPreviousPage, false);
  assert.equal(page1.pageInfo.startCursor, page1.edges[0]!.cursor);
  assert.equal(page1.pageInfo.endCursor, page1.edges[1]!.cursor);

  const page2 = service.fetchConnection(page1.pageInfo.endCursor, 2);
  assert.deepEqual(page2.edges.map((e) => e.node.id), ['k02', 'k03']);
  assert.equal(page2.pageInfo.hasNextPage, true);
  assert.equal(page2.pageInfo.hasPreviousPage, true);

  const page3 = service.fetchConnection(page2.pageInfo.endCursor, 2);
  assert.deepEqual(page3.edges.map((e) => e.node.id), ['k04']);
  assert.equal(page3.pageInfo.hasNextPage, false);
});

test('cursor stays stable across inserts and deletes (key anchored)', () => {
  const service = seedService(5);
  const page1 = service.fetchConnection(null, 2);
  const endCursor = page1.pageInfo.endCursor!;
  assert.equal(decodeCursor(endCursor).key, 'k01');

  service.upsert('k00a', 'inserted');
  service.delete('k00');

  const page2 = service.fetchConnection(endCursor, 10);
  assert.deepEqual(page2.edges.map((e) => e.node.id), ['k02', 'k03', 'k04']);
});

test('upsert bumps node version and store generation', () => {
  const service = new SyncService<string>();
  const gen0 = service.storeGeneration;
  const node = service.upsert('a', 'v1');
  assert.equal(node.version, 1);
  const updated = service.upsert('a', 'v2');
  assert.equal(updated.version, 2);
  assert.equal(service.storeGeneration, gen0 + 2);
  service.delete('a');
  assert.equal(service.storeGeneration, gen0 + 3);
  assert.equal(service.size, 0);
});

test('rejects invalid pagination arguments', () => {
  const service = seedService(1);
  assert.throws(() => service.fetchConnection(null, 0), RangeError);
  assert.throws(() => service.fetchConnection('garbage', 1));
});
