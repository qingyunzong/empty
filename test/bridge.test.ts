import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageBridge, MESSAGE_KIND, type OperationMap } from '../src/bridge.js';
import { FakeWindowAdapter, SeededRandomSource, deferred, flushMicrotasks } from './fakes.js';

const ORIGIN = 'https://collector.example';
const EVIL_ORIGIN = 'https://evil.example';

interface Harness {
  adapter: FakeWindowAdapter;
  bridge: MessageBridge;
  calls: Array<{ op: string; params: unknown }>;
  slow: ReturnType<typeof deferred>;
}

function makeHarness(windowSize?: number): Harness {
  const adapter = new FakeWindowAdapter();
  const calls: Harness['calls'] = [];
  const slow = deferred<unknown>();
  const operations: OperationMap = {
    echo: {
      validate(params: unknown) {
        if (typeof params !== 'object' || params === null) throw new Error('params must be an object');
        return params;
      },
      execute(params: unknown) {
        calls.push({ op: 'echo', params });
        return params;
      },
    },
    slow: {
      validate(params: unknown) {
        return params;
      },
      execute(params: unknown) {
        calls.push({ op: 'slow', params });
        return slow.promise;
      },
    },
  };
  const bridge = new MessageBridge({
    allowedOrigin: ORIGIN,
    adapter,
    random: new SeededRandomSource(),
    operations,
    windowSize,
  });
  return { adapter, bridge, calls, slow };
}

function handshake(adapter: FakeWindowAdapter, source?: unknown): string {
  const win = source ?? adapter.current;
  adapter.emit(ORIGIN, win, { kind: MESSAGE_KIND.handshake });
  const ack = adapter.last();
  assert.equal(ack?.message.kind, MESSAGE_KIND.handshakeAck);
  return ack?.message.nonce as string;
}

function sendOp(
  adapter: FakeWindowAdapter,
  nonce: string,
  seq: number,
  op: string,
  params: unknown,
  source?: unknown,
  origin: string = ORIGIN,
): void {
  adapter.emit(origin, source ?? adapter.current, {
    kind: MESSAGE_KIND.op,
    nonce,
    seq,
    op,
    params,
  });
}

test('handshake issues a nonce from the injected random source', () => {
  const { adapter, bridge } = makeHarness();
  const nonce = handshake(adapter);
  assert.equal(nonce, '000102030405060708090a0b0c0d0e0f');
  const ack = adapter.last();
  assert.equal(ack?.origin, ORIGIN);
  assert.equal(ack?.target, adapter.windowA);
  bridge.destroy();
});

test('silently drops messages from a forged origin', async () => {
  const { adapter, bridge, calls } = makeHarness();
  adapter.emit(EVIL_ORIGIN, adapter.windowA, { kind: MESSAGE_KIND.handshake });
  assert.equal(adapter.sent.length, 0);

  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'echo', { a: 1 }, adapter.windowA, EVIL_ORIGIN);
  await flushMicrotasks();
  assert.equal(adapter.sent.length, 1);
  assert.equal(calls.length, 0);
  bridge.destroy();
});

test('silently drops messages from a non-current window object', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'echo', { a: 1 }, adapter.windowB);
  await flushMicrotasks();
  assert.equal(adapter.results().length, 0);
  assert.equal(calls.length, 0);
  bridge.destroy();
});

test('executes ops in order and replies with results', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'echo', { a: 1 });
  sendOp(adapter, nonce, 2, 'echo', { b: 2 });
  await flushMicrotasks();
  assert.deepEqual(calls, [
    { op: 'echo', params: { a: 1 } },
    { op: 'echo', params: { b: 2 } },
  ]);
  const results = adapter.results();
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    kind: MESSAGE_KIND.result, protocol: 1, nonce, seq: 1, ok: true, value: { a: 1 },
  });
  assert.deepEqual(results[1], {
    kind: MESSAGE_KIND.result, protocol: 1, nonce, seq: 2, ok: true, value: { b: 2 },
  });
  bridge.destroy();
});

test('identical duplicate resends the cached result without re-executing', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'echo', { a: 1 });
  await flushMicrotasks();
  sendOp(adapter, nonce, 1, 'echo', { a: 1 });
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  const results = adapter.results();
  assert.equal(results.length, 2);
  assert.deepEqual(results[1], results[0]);
  bridge.destroy();
});

test('conflicting duplicate sequence is rejected', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'echo', { a: 1 });
  await flushMicrotasks();
  sendOp(adapter, nonce, 1, 'echo', { a: 999 });
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  const last = adapter.results().at(-1);
  assert.equal(last?.ok, false);
  assert.equal((last?.error as { code: string }).code, 'seq-replay-conflict');
  bridge.destroy();
});

test('out-of-order messages within the window are buffered and run in sequence order', async () => {
  const { adapter, bridge, calls } = makeHarness(4);
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 3, 'echo', { n: 3 });
  sendOp(adapter, nonce, 2, 'echo', { n: 2 });
  await flushMicrotasks();
  assert.equal(calls.length, 0);
  sendOp(adapter, nonce, 1, 'echo', { n: 1 });
  await flushMicrotasks();
  assert.deepEqual(calls.map((c) => (c.params as { n: number }).n), [1, 2, 3]);
  assert.deepEqual(adapter.results().map((r) => r.seq), [1, 2, 3]);
  bridge.destroy();
});

test('sequence beyond the receive window is rejected', async () => {
  const { adapter, bridge, calls } = makeHarness(2);
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 3, 'echo', { n: 3 });
  await flushMicrotasks();
  const last = adapter.results().at(-1);
  assert.equal(last?.ok, false);
  assert.equal((last?.error as { code: string }).code, 'seq-out-of-window');
  assert.equal(calls.length, 0);
  bridge.destroy();
});

test('buffered duplicate with different content is rejected', async () => {
  const { adapter, bridge, calls } = makeHarness(4);
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 2, 'echo', { n: 2 });
  sendOp(adapter, nonce, 2, 'echo', { n: 22 });
  await flushMicrotasks();
  const last = adapter.results().at(-1);
  assert.equal((last?.error as { code: string }).code, 'seq-replay-conflict');
  assert.equal(calls.length, 0);
  bridge.destroy();
});

test('navigation invalidates the old session immediately', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  adapter.navigate(adapter.windowB);

  sendOp(adapter, nonce, 1, 'echo', { a: 1 }, adapter.windowA);
  await flushMicrotasks();
  assert.equal(calls.length, 0);
  assert.equal(adapter.results().length, 0);

  sendOp(adapter, nonce, 1, 'echo', { a: 1 }, adapter.windowB);
  await flushMicrotasks();
  const last = adapter.results().at(-1);
  assert.equal((last?.error as { code: string }).code, 'no-session');
  assert.equal(calls.length, 0);
  bridge.destroy();
});

test('async completion after navigation never replies to the new window', async () => {
  const { adapter, bridge, calls, slow } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'slow', { job: 1 });
  await flushMicrotasks();
  assert.equal(calls.length, 1);

  adapter.navigate(adapter.windowB);
  const sentBefore = adapter.sent.length;
  slow.resolve({ done: true });
  await flushMicrotasks();
  assert.equal(adapter.sent.length, sentBefore);

  const newNonce = handshake(adapter, adapter.windowB);
  assert.notEqual(newNonce, nonce);
  sendOp(adapter, newNonce, 1, 'echo', { fresh: true }, adapter.windowB);
  await flushMicrotasks();
  const last = adapter.results().at(-1);
  assert.equal(last?.ok, true);
  assert.equal(last?.nonce, newNonce);
  assert.deepEqual(last?.value, { fresh: true });
  bridge.destroy();
});

test('params are validated before any host operation runs', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 1, 'echo', 42);
  await flushMicrotasks();
  assert.equal(calls.length, 0);
  const last = adapter.results().at(-1);
  assert.equal(last?.ok, false);
  assert.equal((last?.error as { code: string }).code, 'invalid-params');

  sendOp(adapter, nonce, 2, 'echo', { ok: true });
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  bridge.destroy();
});

test('validation of a buffered message happens before its execution', async () => {
  const { adapter, bridge, calls } = makeHarness(4);
  const nonce = handshake(adapter);
  sendOp(adapter, nonce, 2, 'echo', 'not-an-object');
  sendOp(adapter, nonce, 1, 'echo', { n: 1 });
  await flushMicrotasks();
  assert.deepEqual(calls, [{ op: 'echo', params: { n: 1 } }]);
  const results = adapter.results();
  assert.equal(results.length, 2);
  assert.equal((results[1].error as { code: string }).code, 'invalid-params');
  assert.equal(results[1].seq, 2);
  bridge.destroy();
});

test('bad nonce and unknown operation are rejected without executing', async () => {
  const { adapter, bridge, calls } = makeHarness();
  const nonce = handshake(adapter);
  sendOp(adapter, 'deadbeef', 1, 'echo', { a: 1 });
  await flushMicrotasks();
  assert.equal((adapter.results().at(-1)?.error as { code: string }).code, 'bad-nonce');

  sendOp(adapter, nonce, 1, 'nope', {});
  await flushMicrotasks();
  assert.equal((adapter.results().at(-1)?.error as { code: string }).code, 'unknown-op');
  assert.equal(calls.length, 0);

  sendOp(adapter, nonce, 2, 'echo', { a: 2 });
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  bridge.destroy();
});
