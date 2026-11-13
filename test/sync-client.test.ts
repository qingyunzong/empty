import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCursor, encodeCursor } from '../src/cursor.ts';
import type { Connection, VersionedNode } from '../src/relay.ts';
import {
  CursorViolationError,
  MemoryCheckpointStore,
  START_POSITION,
  SyncClient,
} from '../src/sync-client.ts';
import type { Batch } from '../src/sync-client.ts';
import { SyncService } from '../src/sync-service.ts';
import type { SyncNode } from '../src/sync-service.ts';

interface Row extends VersionedNode {}

function offsetCursor(offset: number): string {
  return encodeCursor(String(offset).padStart(8, '0'), 0);
}

function makeOffsetServer(ids: Array<string>) {
  const rows: Array<Row> = ids.map((id) => ({ id, version: 1 }));
  const fetchPage = async (after: string | null, first: number): Promise<Connection<Row>> => {
    const start = after === null ? 0 : Number(decodeCursor(after).key) + 1;
    const slice = rows.slice(start, start + first);
    return {
      edges: slice.map((node, i) => ({ node: { ...node }, cursor: offsetCursor(start + i) })),
      pageInfo: {
        hasNextPage: start + slice.length < rows.length,
        hasPreviousPage: start > 0,
        startCursor: slice.length > 0 ? offsetCursor(start) : null,
        endCursor: slice.length > 0 ? offsetCursor(start + slice.length - 1) : null,
      },
    };
  };
  return { rows, fetchPage };
}

function makeServiceClient(
  service: SyncService<string>,
  options: { checkpoint?: MemoryCheckpointStore; pageSize?: number; batchSize?: number } = {},
) {
  return new SyncClient<SyncNode<string>>({
    fetchPage: async (after, first) => service.fetchConnection(after, first),
    checkpoint: options.checkpoint,
    pageSize: options.pageSize ?? 3,
    batchSize: options.batchSize ?? 4,
  });
}

async function collectAll<T extends VersionedNode>(
  client: SyncClient<T>,
): Promise<Array<Batch<T>>> {
  const batches: Array<Batch<T>> = [];
  for await (const batch of client.run()) {
    client.ack(batch);
    batches.push(batch);
  }
  return batches;
}

function seedService(count: number): SyncService<string> {
  const service = new SyncService<string>();
  for (let i = 0; i < count; i += 1) {
    service.upsert(`k${String(i).padStart(2, '0')}`, `value-${i}`);
  }
  return service;
}

test('traverses a Relay connection end to end in batches', async () => {
  const service = seedService(10);
  const client = makeServiceClient(service);
  const batches = await collectAll(client);

  assert.deepEqual(batches.map((b) => b.items.length), [4, 4, 2]);
  const items = batches.flatMap((b) => b.items);
  assert.deepEqual(
    items.map((i) => i.key),
    Array.from({ length: 10 }, (_, i) => `k${String(i).padStart(2, '0')}`),
  );
  for (const item of items) {
    assert.equal(item.version, 1);
    assert.equal(typeof item.firstSeenAt, 'string');
    assert.equal(typeof item.cursor, 'string');
  }
  assert.equal(items[0]!.firstSeenAt, START_POSITION);
  assert.equal(client.lastAckedCursor, batches[batches.length - 1]!.endCursor);
});

test('tolerates page overlap from server-side inserts without duplicating output', async () => {
  const server = makeOffsetServer(['a', 'b', 'c', 'd', 'e', 'f']);
  let fetches = 0;
  const wrapped = async (after: string | null, first: number): Promise<Connection<Row>> => {
    fetches += 1;
    if (fetches === 2) {
      server.rows.splice(1, 0, { id: 'a0', version: 1 });
    }
    return server.fetchPage(after, first);
  };
  const overlapping = new SyncClient<Row>({ fetchPage: wrapped, pageSize: 2, batchSize: 100 });

  const batches = await collectAll(overlapping);
  const items = batches.flatMap((b) => b.items);
  const ids = items.map((i) => i.key);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(items.find((i) => i.key === 'b')!.firstSeenAt, START_POSITION);
});

test('re-emits a node when its version advances, keeping the first-seen position', async () => {
  const server = makeOffsetServer(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  let fetches = 0;
  const wrapped = async (after: string | null, first: number): Promise<Connection<Row>> => {
    fetches += 1;
    if (fetches === 2) {
      server.rows[1]!.version = 2;
      server.rows.splice(1, 0, { id: 'a0', version: 1 }, { id: 'a1', version: 1 });
    }
    return server.fetchPage(after, first);
  };
  const client = new SyncClient<Row>({ fetchPage: wrapped, pageSize: 2, batchSize: 100 });
  const batches = await collectAll(client);
  const items = batches.flatMap((b) => b.items);

  const bSightings = items.filter((i) => i.key === 'b');
  assert.equal(bSightings.length, 2);
  assert.deepEqual(bSightings.map((i) => i.version), [1, 2]);
  assert.equal(bSightings[0]!.firstSeenAt, START_POSITION);
  assert.equal(bSightings[1]!.firstSeenAt, START_POSITION);

  const cSightings = items.filter((i) => i.key === 'c');
  assert.equal(cSightings.length, 1);
});

test('stagnating cursor triggers bounded recovery then fails', async () => {
  let fetchCount = 0;
  const stuck = async (): Promise<Connection<Row>> => {
    fetchCount += 1;
    return {
      edges: [{ node: { id: 'x', version: 1 }, cursor: encodeCursor('x', 0) }],
      pageInfo: {
        hasNextPage: true,
        hasPreviousPage: false,
        startCursor: encodeCursor('x', 0),
        endCursor: encodeCursor('x', 0),
      },
    };
  };
  const client = new SyncClient<Row>({
    fetchPage: stuck,
    pageSize: 2,
    batchSize: 100,
    maxRecoveryAttempts: 2,
  });
  await assert.rejects(
    async () => collectAll(client),
    (error: unknown) => {
      assert.ok(error instanceof CursorViolationError);
      assert.equal(error.reason, 'not-advanced');
      assert.equal(error.attempts, 3);
      return true;
    },
  );
  assert.equal(fetchCount, 4);
});

test('regressing cursor triggers bounded recovery then fails', async () => {
  let fetchCount = 0;
  const regressing = async (): Promise<Connection<Row>> => {
    fetchCount += 1;
    const key = fetchCount === 1 ? 'm' : 'a';
    return {
      edges: [{ node: { id: key, version: 1 }, cursor: encodeCursor(key, 0) }],
      pageInfo: {
        hasNextPage: true,
        hasPreviousPage: false,
        startCursor: encodeCursor(key, 0),
        endCursor: encodeCursor(key, 0),
      },
    };
  };
  const client = new SyncClient<Row>({
    fetchPage: regressing,
    pageSize: 2,
    batchSize: 100,
    maxRecoveryAttempts: 1,
  });
  await assert.rejects(
    async () => collectAll(client),
    (error: unknown) => {
      assert.ok(error instanceof CursorViolationError);
      assert.equal(error.reason, 'regressed');
      return true;
    },
  );
  assert.equal(fetchCount, 3);
});

test('cancel then resume does not replay acknowledged batches', async () => {
  const service = seedService(10);
  const checkpoint = new MemoryCheckpointStore();

  const first = makeServiceClient(service, { checkpoint });
  const gen = first.run();
  const head = await gen.next();
  if (head.done) assert.fail('expected a first batch');
  assert.deepEqual(
    head.value.items.map((i) => i.key),
    ['k00', 'k01', 'k02', 'k03'],
  );
  first.ack(head.value);
  first.cancel();
  assert.equal((await gen.next()).done, true);

  const resumed = makeServiceClient(service, { checkpoint });
  const batches = await collectAll(resumed);
  const ids = batches.flatMap((b) => b.items).map((i) => i.key);
  assert.deepEqual(ids, ['k04', 'k05', 'k06', 'k07', 'k08', 'k09']);
  for (const id of ['k00', 'k01', 'k02', 'k03']) {
    assert.ok(!ids.includes(id), `acked item ${id} must not replay`);
  }
});

test('unacknowledged batches may replay after cancel (at-least-once)', async () => {
  const service = seedService(6);
  const checkpoint = new MemoryCheckpointStore();

  const first = makeServiceClient(service, { checkpoint });
  const gen = first.run();
  const head = await gen.next();
  if (head.done) assert.fail('expected a first batch');
  first.cancel();
  assert.equal((await gen.next()).done, true);
  assert.equal(checkpoint.load(), null);

  const resumed = makeServiceClient(service, { checkpoint });
  const batches = await collectAll(resumed);
  const ids = batches.flatMap((b) => b.items).map((i) => i.key);
  assert.deepEqual(ids, ['k00', 'k01', 'k02', 'k03', 'k04', 'k05']);
});

test('empty connection completes without batches', async () => {
  const service = new SyncService<string>();
  const client = makeServiceClient(service);
  const batches = await collectAll(client);
  assert.deepEqual(batches, []);
});
