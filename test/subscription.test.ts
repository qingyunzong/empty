import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AsyncAuthorizer,
  ControlledExecutor,
  DataStore,
  SubscriptionLibrary,
  visibleSync,
} from '../src/index';
import type { Item, Message, Policy, Subject } from '../src/index';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const subject: Subject = { id: 'user-1', roles: ['reader'] };

function makeWorld(policy: Policy) {
  const store = new DataStore();
  const executor = new ControlledExecutor();
  const library = new SubscriptionLibrary(store, new AsyncAuthorizer(executor), policy);
  return { store, executor, library };
}

function syncIds(store: DataStore, policy: Policy): string[] {
  return visibleSync(policy, store.snapshot(), subject)
    .map((item) => item.id)
    .sort();
}

function assertMessageInvariants(messages: Message[]): void {
  messages.forEach((message, index) => {
    assert.equal(message.version, index + 1, 'message versions must be consecutive from 1');
  });
  const byGeneration = new Map<number, Message[]>();
  for (const message of messages) {
    const group = byGeneration.get(message.generation) ?? [];
    group.push(message);
    byGeneration.set(message.generation, group);
  }
  for (const [generation, group] of byGeneration) {
    const lastDelete = group.map((m) => m.kind).lastIndexOf('delete');
    const firstUpsert = group.findIndex((m) => m.kind === 'upsert');
    assert.ok(
      lastDelete === -1 || firstUpsert === -1 || lastDelete < firstUpsert,
      `generation ${generation}: all deletes must precede any upsert`,
    );
  }
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(values: T[], rng: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = tmp;
  }
  return copy;
}

test('初始订阅仅发布授权可见数据，消息版本从 1 连续递增', async () => {
  const policy: Policy = (item) => (item.level as number) <= 5;
  const { store, executor, library } = makeWorld(policy);
  store.upsert({ id: 'a', level: 1 });
  store.upsert({ id: 'b', level: 9 });
  store.upsert({ id: 'c', level: 3 });

  const session = library.subscribe(subject);
  executor.completeAll();
  await flush();

  assert.deepEqual(session.visibleIds(), ['a', 'c']);
  assert.deepEqual(
    session.messages.map((m) => (m.kind === 'upsert' ? m.item.id : m.id)),
    ['a', 'c'],
  );
  assertMessageInvariants(session.messages);
  assert.deepEqual(session.visibleIds(), syncIds(store, policy));
});

test('数据变更触发重评估：新增可见、不可见无消息、删除发 delete', async () => {
  const policy: Policy = (item) => (item.level as number) <= 5;
  const { store, executor, library } = makeWorld(policy);
  store.upsert({ id: 'a', level: 1 });

  const session = library.subscribe(subject);
  executor.completeAll();
  await flush();
  assert.deepEqual(session.visibleIds(), ['a']);

  store.upsert({ id: 'b', level: 3 });
  executor.completeAll();
  await flush();
  assert.deepEqual(session.visibleIds(), ['a', 'b']);

  const before = session.messages.length;
  store.upsert({ id: 'hidden', level: 9 });
  executor.completeAll();
  await flush();
  assert.equal(session.messages.length, before, 'invisible item must not produce messages');

  store.remove('a');
  executor.completeAll();
  await flush();
  assert.deepEqual(session.visibleIds(), ['b']);
  const last = session.messages.at(-1);
  assert.ok(last && last.kind === 'delete' && last.id === 'a');

  store.upsert({ id: 'b', level: 4, note: 'changed' });
  executor.completeAll();
  await flush();
  const updated = session.messages.at(-1);
  assert.ok(updated && updated.kind === 'upsert' && updated.item.note === 'changed');

  assertMessageInvariants(session.messages);
  assert.deepEqual(session.visibleIds(), syncIds(store, policy));
});

test('策略撤销：同一评估周期内先发删除再发新数据', async () => {
  let policy: Policy = (item) => (item.level as number) <= 2;
  const { store, executor, library } = makeWorld(policy);
  store.upsert({ id: 'a', level: 1 });
  store.upsert({ id: 'b', level: 2 });
  store.upsert({ id: 'c', level: 9 });

  const session = library.subscribe(subject);
  executor.completeAll();
  await flush();
  assert.deepEqual(session.visibleIds(), ['a', 'b']);

  policy = (item) => (item.level as number) >= 2;
  library.setPolicy(policy);
  executor.completeAll();
  await flush();

  assert.deepEqual(session.visibleIds(), ['b', 'c']);
  const cycle = session.messages.filter((m) => m.policyVersion === 1);
  assert.deepEqual(
    cycle.map((m) => (m.kind === 'delete' ? `del:${m.id}` : `up:${m.item.id}`)),
    ['del:a', 'up:c'],
    'revocation must publish deletes before new data',
  );
  assertMessageInvariants(session.messages);
  assert.deepEqual(session.visibleIds(), syncIds(store, policy));
});

test('乱序完成：旧异步查询结果禁止发布', async () => {
  let policy: Policy = () => true;
  const { store, executor, library } = makeWorld(policy);
  store.upsert({ id: 'a', level: 1 });
  store.upsert({ id: 'b', level: 9 });

  const session = library.subscribe(subject);
  const staleTickets = executor.tickets();
  assert.equal(staleTickets.length, 2);

  policy = (item) => (item.level as number) <= 5;
  library.setPolicy(policy);
  const freshTickets = executor.tickets().filter((t) => !staleTickets.includes(t));
  assert.equal(freshTickets.length, 2);

  // Complete the newer generation first, simulating out-of-order completion.
  executor.completeAll(freshTickets);
  await flush();
  assert.deepEqual(session.visibleIds(), ['a']);
  const publishedAfterFresh = session.messages.length;
  assert.ok(publishedAfterFresh > 0);
  assert.ok(session.messages.every((m) => m.generation === 2));

  // Stale generation completes afterwards: nothing may be published.
  executor.completeAll(staleTickets);
  await flush();
  assert.equal(session.messages.length, publishedAfterFresh, 'stale results must not publish');
  assert.deepEqual(session.visibleIds(), ['a']);
  assert.deepEqual(session.visibleIds(), syncIds(store, policy));
  assertMessageInvariants(session.messages);
});

test('随机乱序完成与同步授权查询核对', async () => {
  const rng = mulberry32(20261005);
  let threshold = 5;
  let policy: Policy = (item) => (item.level as number) <= threshold;
  const { store, executor, library } = makeWorld(policy);

  const session = library.subscribe(subject);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];

  for (let round = 0; round < 40; round += 1) {
    const ops = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < ops; i += 1) {
      const pick = rng();
      if (pick < 0.45) {
        const id = ids[Math.floor(rng() * ids.length)] as string;
        store.upsert({ id, level: Math.floor(rng() * 10), round });
      } else if (pick < 0.7) {
        store.remove(ids[Math.floor(rng() * ids.length)] as string);
      } else {
        threshold = Math.floor(rng() * 10);
        library.setPolicy(policy);
      }
    }
    executor.completeAll(shuffled(executor.tickets(), rng));
    await flush();
    assert.deepEqual(
      session.visibleIds(),
      syncIds(store, policy),
      `round ${round}: async visible set must match synchronous authorization`,
    );
  }

  assert.equal(executor.pendingCount, 0);
  assertMessageInvariants(session.messages);
});

test('关闭会话后不再发布任何消息', async () => {
  const policy: Policy = () => true;
  const { store, executor, library } = makeWorld(policy);
  store.upsert({ id: 'a', level: 1 });

  const session = library.subscribe(subject);
  executor.completeAll();
  await flush();
  const published = session.messages.length;

  session.close();
  store.upsert({ id: 'b', level: 2 });
  library.setPolicy(() => false);
  executor.completeAll();
  await flush();

  assert.equal(session.messages.length, published);
  assert.equal(executor.pendingCount, 0);
});
