import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTopic, Topic, Subscription } from '../src/pubsub.js';

/** A manually controlled ("可控") promise. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type State = 'pending' | 'fulfilled' | 'rejected';

/** Deterministically inspects a promise: an already-settled promise wins over setImmediate. */
async function stateOf(promise: Promise<unknown>): Promise<State> {
  const pending = Symbol('pending');
  const result = await Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    tick().then(() => pending),
  ]);
  if (result === pending) return 'pending';
  return result as 'fulfilled' | 'rejected';
}

/** Drains a subscription until `done`, counting deliveries. */
async function collect<T>(sub: Subscription<T>, into: T[]): Promise<number> {
  let count = 0;
  for await (const value of sub) {
    into.push(value);
    count += 1;
  }
  return count;
}

test('async iterator delivers messages in FIFO order and return() ends iteration', async () => {
  const topic = createTopic<number>({ capacity: 4 });
  const sub = topic.subscribe();

  await topic.publish(1);
  await topic.publish(2);
  await topic.publish(3);
  assert.equal(sub.pending, 3);

  assert.deepEqual(await sub.next(), { value: 1, done: false });
  assert.deepEqual(await sub.next(), { value: 2, done: false });

  const done = deferred<IteratorResult<number>>();
  void sub.return().then((result) => done.resolve(result));
  assert.deepEqual(await done.promise, { value: undefined, done: true });
  assert.deepEqual(await sub.next(), { value: undefined, done: true });
  assert.equal(sub.isClosed, true);
});

test('return() closes only that subscription (delivery counts)', async () => {
  const topic = createTopic<string>({ capacity: 8 });
  const leaving = topic.subscribe();
  const staying = topic.subscribe();

  await topic.publish('m1');
  assert.deepEqual(await leaving.next(), { value: 'm1', done: false });
  await leaving.return();
  assert.deepEqual(await leaving.next(), { value: undefined, done: true });

  await topic.publish('m2');
  await topic.publish('m3');
  topic.close();

  const received: string[] = [];
  const count = await collect(staying, received);
  assert.deepEqual(received, ['m1', 'm2', 'm3']);
  assert.equal(count, 3);
});

test('full slow subscriber blocks publish; consuming unblocks it (termination order)', async () => {
  const topic = createTopic<string>({ capacity: 1 });
  const sub = topic.subscribe();
  const events: string[] = [];

  await topic.publish('a');
  const blocked = deferred<void>();
  const p2 = topic.publish('b').then(() => blocked.resolve());

  await tick();
  assert.equal(await stateOf(p2), 'pending', 'publish must block while the queue is full');

  const first = await sub.next();
  events.push(`consumed:${String(first.value)}`);
  await blocked.promise;
  events.push('publish:b resolved');

  const second = await sub.next();
  events.push(`consumed:${String(second.value)}`);

  assert.deepEqual(events, ['consumed:a', 'publish:b resolved', 'consumed:b']);
});

test('cancelling a blocked publisher releases its reserved slot', async () => {
  const topic = createTopic<string>({ capacity: 1 });
  const sub = topic.subscribe();
  const delivered: string[] = [];

  await topic.publish('A'); // fills the queue

  const controller = new AbortController();
  const pB = topic.publish('B', { signal: controller.signal });
  const pC = topic.publish('C'); // queued behind B

  await tick();
  assert.equal(await stateOf(pB), 'pending');
  assert.equal(await stateOf(pC), 'pending');

  controller.abort();
  await assert.rejects(pB, { name: 'AbortError' });
  assert.equal(await stateOf(pC), 'pending', 'C still waits for a real free slot');

  delivered.push((await sub.next()).value as string); // A; freed slot must go to C, not B
  assert.equal(await stateOf(pC), 'fulfilled');
  delivered.push((await sub.next()).value as string); // C

  assert.deepEqual(delivered, ['A', 'C'], 'B was cancelled and must never be delivered');
  assert.equal(delivered.length, 2);
});

test('aborting before publish rejects immediately without enqueuing', async () => {
  const topic = createTopic<string>({ capacity: 1 });
  const sub = topic.subscribe();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(topic.publish('x', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sub.pending, 0);
  topic.close();
});

test('publish racing a subscriber exit does not lose other subscribers messages', async () => {
  const topic = createTopic<string>({ capacity: 1 });
  const slow = topic.subscribe();
  const fast = topic.subscribe({ capacity: 4 });
  const events: string[] = [];

  await topic.publish('m0'); // slow is now full (never consumes), fast buffered m0

  const published = deferred<void>();
  const p1 = topic.publish('m1').then(() => {
    events.push('publish:m1 resolved');
    published.resolve();
  });

  await tick();
  assert.equal(await stateOf(p1), 'pending', 'blocked on the full slow subscriber');

  await slow.return(); // exit races the in-flight publish
  events.push('slow closed');
  await published.promise;

  await topic.publish('m2');
  topic.close();

  const received: string[] = [];
  const count = await collect(fast, received);
  assert.deepEqual(received, ['m0', 'm1', 'm2'], 'fast subscriber must not lose messages');
  assert.equal(count, 3);
  assert.deepEqual(events, ['slow closed', 'publish:m1 resolved']);
});

test('close order: return() releases the blocked publisher before iteration ends', async () => {
  const topic = createTopic<string>({ capacity: 1 });
  const sub = topic.subscribe();
  const events: string[] = [];

  await topic.publish('A'); // buffered, never consumed
  const pB = topic.publish('B'); // blocked: queue full
  void pB.then(() => events.push('publisher-unblocked'));

  await tick();
  assert.equal(await stateOf(pB), 'pending');

  const closed = deferred<void>();
  void sub.return().then(() => closed.resolve());
  await closed.promise;
  events.push('iterator-returned');

  // The blocked publisher was already released synchronously inside close().
  assert.equal(await stateOf(pB), 'fulfilled');

  const after = await sub.next();
  events.push(`next-after-close:done=${String(after.done)}`);
  await tick();

  assert.deepEqual(events, [
    'iterator-returned',
    'publisher-unblocked',
    'next-after-close:done=true',
  ]);
  assert.equal(sub.pending, 0, 'dropped message must not remain buffered');
});

test('multiple blocked publishers are promoted in FIFO order', async () => {
  const topic: Topic<string> = createTopic<string>({ capacity: 1 });
  const sub = topic.subscribe();
  const delivered: string[] = [];

  await topic.publish('first');
  const p1 = topic.publish('second');
  const p2 = topic.publish('third');
  await tick();
  assert.equal(await stateOf(p1), 'pending');
  assert.equal(await stateOf(p2), 'pending');

  for (let i = 0; i < 3; i += 1) {
    delivered.push((await sub.next()).value as string);
  }
  await Promise.all([p1, p2]);
  assert.deepEqual(delivered, ['first', 'second', 'third']);
  topic.close();
});

test('for-await loop exits cleanly on return() with exact delivery count', async () => {
  const topic = createTopic<number>({ capacity: 2 });
  const sub = topic.subscribe();

  await topic.publish(10);
  await topic.publish(20);

  const received: number[] = [];
  const loop = (async () => {
    for await (const value of sub) {
      received.push(value);
      if (received.length === 2) {
        // Give the publisher time to enqueue one more, then exit the loop.
        await topic.publish(30);
        break; // triggers return()
      }
    }
  })();

  await loop;
  assert.deepEqual(received, [10, 20]);
  assert.equal(sub.isClosed, true);

  // Publishing after the loop exited must not throw nor block.
  await topic.publish(40);
  assert.equal(topic.subscriberCount, 0);
});
