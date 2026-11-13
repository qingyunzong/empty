import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FormBridgeHost } from '../src/host.ts';
import { FormBridgeClient } from '../src/client.ts';
import { MESSAGE_CHANNEL } from '../src/protocol.ts';
import {
  BridgeDestroyedError,
  BridgeNavigationError,
  BridgeTimeoutError,
} from '../src/errors.ts';
import type {
  EventTargetLike,
  LoadEventTargetLike,
  MessageEventLike,
  MessageListener,
  WindowLike,
} from '../src/events.ts';
import type { FieldSpec, FieldValues } from '../src/protocol.ts';

const HOST_ORIGIN = 'https://host.example';
const FORM_ORIGIN = 'https://form.example';

class FakeWindow implements EventTargetLike {
  private readonly listeners = new Set<MessageListener>();

  constructor(readonly origin: string) {}

  addEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  dispatchMessage(event: MessageEventLike): void {
    setTimeout(() => {
      for (const listener of [...this.listeners]) listener(event);
    }, 0);
  }
}

interface WindowPair {
  parentViewOfFrame: WindowLike;
  frameViewOfParent: WindowLike;
  postedToFrame: unknown[];
  postedToParent: unknown[];
}

function connect(parent: FakeWindow, frame: FakeWindow): WindowPair {
  const postedToFrame: unknown[] = [];
  const postedToParent: unknown[] = [];
  const parentViewOfFrame: WindowLike = {
    postMessage: (data) => {
      postedToFrame.push(data);
      frame.dispatchMessage({ origin: parent.origin, source: frameViewOfParent, data });
    },
  };
  const frameViewOfParent: WindowLike = {
    postMessage: (data) => {
      postedToParent.push(data);
      parent.dispatchMessage({ origin: frame.origin, source: parentViewOfFrame, data });
    },
  };
  return { parentViewOfFrame, frameViewOfParent, postedToFrame, postedToParent };
}

class FakeIframe implements LoadEventTargetLike {
  contentWindow: WindowLike | null = null;
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'load', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'load', listener: () => void): void {
    this.listeners.delete(listener);
  }

  navigate(contentWindow: WindowLike | null): void {
    this.contentWindow = contentWindow;
    for (const listener of [...this.listeners]) listener();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await tick();
}

function idGenerator(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}

interface Harness {
  parent: FakeWindow;
  frame: FakeWindow;
  pair: WindowPair;
  iframe: FakeIframe;
  host: FormBridgeHost;
  client: FormBridgeClient;
  postedToFrame: unknown[];
  onFieldsCalls: FieldSpec[][];
}

function createHarness(options?: {
  timeoutMs?: number;
  onFields?: (fields: FieldSpec[]) => FieldValues;
  withClient?: boolean;
}): Harness {
  const parent = new FakeWindow(HOST_ORIGIN);
  const frame = new FakeWindow(FORM_ORIGIN);
  const pair = connect(parent, frame);
  const iframe = new FakeIframe();
  iframe.contentWindow = pair.parentViewOfFrame;

  const onFieldsCalls: FieldSpec[][] = [];
  const host = new FormBridgeHost({
    eventTarget: parent,
    getSourceWindow: () => iframe.contentWindow,
    expectedOrigin: FORM_ORIGIN,
    iframe,
    timeoutMs: options?.timeoutMs,
    generateId: idGenerator('host'),
  });
  const client = new FormBridgeClient({
    eventTarget: frame,
    getParentWindow: () => pair.frameViewOfParent,
    parentOrigin: HOST_ORIGIN,
    bootId: 'boot-1',
    onFields: (fields) => {
      onFieldsCalls.push(fields);
      return options?.onFields?.(fields) ?? { email: 'a@b.c' };
    },
  });
  host.start();
  if (options?.withClient !== false) client.start();
  return {
    parent,
    frame,
    pair,
    iframe,
    host,
    client,
    postedToFrame: pair.postedToFrame,
    onFieldsCalls,
  };
}

const FIELDS: FieldSpec[] = [{ name: 'email', required: true }];

test('完整事务：ready → init → fields-request → complete', async () => {
  const harness = createHarness();
  const values = await harness.host.collect(FIELDS);
  assert.deepEqual(values, { email: 'a@b.c' });
  assert.deepEqual(harness.onFieldsCalls, [FIELDS]);

  const phases = (harness.postedToFrame as { phase?: string }[]).map((m) => m.phase);
  assert.deepEqual(phases, ['init', 'fields-request']);
  harness.host.destroy();
  harness.client.destroy();
});

test('拒绝错误 origin 的消息', async () => {
  const harness = createHarness({ timeoutMs: 40, withClient: false });
  const pending = harness.host.collect(FIELDS);
  const rejection = assert.rejects(pending, BridgeTimeoutError);

  harness.parent.dispatchMessage({
    origin: 'https://evil.example',
    source: harness.iframe.contentWindow,
    data: { channel: MESSAGE_CHANNEL, phase: 'ready', bootId: 'boot-x' },
  });
  await settle();
  assert.equal(harness.postedToFrame.length, 0);
  await rejection;
  harness.host.destroy();
  harness.client.destroy();
});

test('拒绝同源其他 frame 的响应（source window 校验）', async () => {
  const harness = createHarness();
  const otherFrame = new FakeWindow(FORM_ORIGIN);
  const otherPair = connect(harness.parent, otherFrame);

  const pending = harness.host.collect(FIELDS);
  await settle();

  const init = harness.postedToFrame[0] as { nonce: string };
  const request = harness.postedToFrame[1] as { requestId: string };

  // 同源另一个 frame 伪造 complete：nonce 与 requestId 全部正确，但 source 不对。
  otherPair.frameViewOfParent.postMessage(
    {
      channel: MESSAGE_CHANNEL,
      phase: 'complete',
      nonce: init.nonce,
      requestId: request.requestId,
      values: { email: 'forged@evil' },
    },
    HOST_ORIGIN,
  );
  await settle();

  const values = await pending;
  assert.deepEqual(values, { email: 'a@b.c' });
  harness.host.destroy();
  harness.client.destroy();
});

test('frame 导航后旧 nonce 失效，新会话重新握手', async () => {
  const harness = createHarness();
  const first = await harness.host.collect(FIELDS);
  assert.deepEqual(first, { email: 'a@b.c' });
  const oldNonce = (harness.postedToFrame[0] as { nonce: string }).nonce;

  // 导航：新文档、新 contentWindow、新 client。
  const frame2 = new FakeWindow(FORM_ORIGIN);
  const pair2 = connect(harness.parent, frame2);
  harness.iframe.navigate(pair2.parentViewOfFrame);
  const client2 = new FormBridgeClient({
    eventTarget: frame2,
    getParentWindow: () => pair2.frameViewOfParent,
    parentOrigin: HOST_ORIGIN,
    bootId: 'boot-2',
    onFields: () => ({ email: 'second@round' }),
  });
  client2.start();
  await settle();

  // 旧 nonce 的迟到 complete（即便 source 伪装成当前 contentWindow）被忽略。
  harness.parent.dispatchMessage({
    origin: FORM_ORIGIN,
    source: harness.iframe.contentWindow,
    data: {
      channel: MESSAGE_CHANNEL,
      phase: 'complete',
      nonce: oldNonce,
      requestId: 'host-2',
      values: { email: 'stale@late' },
    },
  });

  const second = await harness.host.collect(FIELDS);
  assert.deepEqual(second, { email: 'second@round' });

  const newInit = (pair2.postedToFrame as { phase: string; nonce?: string }[]).find(
    (m) => m.phase === 'init' && m.nonce !== oldNonce,
  );
  assert.ok(newInit, '导航后应签发新 nonce');
  harness.host.destroy();
  client2.destroy();
  harness.client.destroy();
});

test('导航使在途请求以 BridgeNavigationError 失败', async () => {
  const parent = new FakeWindow(HOST_ORIGIN);
  const frame = new FakeWindow(FORM_ORIGIN);
  const pair = connect(parent, frame);
  const iframe = new FakeIframe();
  iframe.contentWindow = pair.parentViewOfFrame;
  const host = new FormBridgeHost({
    eventTarget: parent,
    getSourceWindow: () => iframe.contentWindow,
    expectedOrigin: FORM_ORIGIN,
    iframe,
    generateId: idGenerator('host'),
  });
  const client = new FormBridgeClient({
    eventTarget: frame,
    getParentWindow: () => pair.frameViewOfParent,
    parentOrigin: HOST_ORIGIN,
    bootId: 'boot-1',
    onFields: () =>
      new Promise<FieldValues>(() => {
        // 永不返回，模拟缓慢表单。
      }),
  });
  host.start();
  client.start();

  const pending = host.collect(FIELDS);
  const rejection = assert.rejects(pending, BridgeNavigationError);
  await settle();
  iframe.navigate(null);
  await rejection;
  host.destroy();
  client.destroy();
});

test('重复 ready 幂等：重发 init，不重置会话', async () => {
  const harness = createHarness();
  const pending = harness.host.collect(FIELDS);
  await settle();

  harness.client.announceReady();
  harness.client.announceReady();
  await settle();

  const values = await pending;
  assert.deepEqual(values, { email: 'a@b.c' });
  assert.equal(harness.onFieldsCalls.length, 1);

  const inits = (harness.postedToFrame as { phase: string }[]).filter(
    (m) => m.phase === 'init',
  );
  assert.equal(inits.length, 3, '初始 init + 两次重复 ready 的重发');
  harness.host.destroy();
  harness.client.destroy();
});

test('重复 complete 幂等：只结算一次', async () => {
  const harness = createHarness();
  let resolveCount = 0;
  const pending = harness.host.collect(FIELDS).then((values) => {
    resolveCount += 1;
    return values;
  });
  await settle();

  const init = harness.postedToFrame[0] as { nonce: string };
  const request = harness.postedToFrame[1] as { requestId: string };
  const duplicate = {
    channel: MESSAGE_CHANNEL,
    phase: 'complete',
    nonce: init.nonce,
    requestId: request.requestId,
    values: { email: 'dup@msg' },
  };
  harness.parent.dispatchMessage({
    origin: FORM_ORIGIN,
    source: harness.iframe.contentWindow,
    data: duplicate,
  });
  harness.parent.dispatchMessage({
    origin: FORM_ORIGIN,
    source: harness.iframe.contentWindow,
    data: duplicate,
  });

  const values = await pending;
  assert.equal(resolveCount, 1);
  assert.deepEqual(values, { email: 'a@b.c' });
  harness.host.destroy();
  harness.client.destroy();
});

test('重复 fields-request 幂等：onFields 只执行一次，重发缓存回执', async () => {
  const harness = createHarness();
  const pending = harness.host.collect(FIELDS);
  await settle();

  const init = harness.postedToFrame[0] as { nonce: string };
  const request = harness.postedToFrame[1] as { requestId: string };
  // 模拟 host 重发同一个 fields-request。
  harness.pair.parentViewOfFrame.postMessage(
    {
      channel: MESSAGE_CHANNEL,
      phase: 'fields-request',
      nonce: init.nonce,
      requestId: request.requestId,
      fields: FIELDS,
    },
    FORM_ORIGIN,
  );

  const values = await pending;
  assert.deepEqual(values, { email: 'a@b.c' });
  assert.equal(harness.onFieldsCalls.length, 1);
  harness.host.destroy();
  harness.client.destroy();
});

test('乱序 complete（未知 requestId）被忽略，不影响后续正常完成', async () => {
  const harness = createHarness();
  const pending = harness.host.collect(FIELDS);
  await settle();

  const init = harness.postedToFrame[0] as { nonce: string };
  harness.parent.dispatchMessage({
    origin: FORM_ORIGIN,
    source: harness.iframe.contentWindow,
    data: {
      channel: MESSAGE_CHANNEL,
      phase: 'complete',
      nonce: init.nonce,
      requestId: 'host-999',
      values: { email: 'early@bird' },
    },
  });

  const values = await pending;
  assert.deepEqual(values, { email: 'a@b.c' });
  harness.host.destroy();
  harness.client.destroy();
});

test('init 之前到达的 fields-request 被忽略（client 无 nonce）', async () => {
  const parent = new FakeWindow(HOST_ORIGIN);
  const frame = new FakeWindow(FORM_ORIGIN);
  const pair = connect(parent, frame);
  const calls: FieldSpec[][] = [];
  const client = new FormBridgeClient({
    eventTarget: frame,
    getParentWindow: () => pair.frameViewOfParent,
    parentOrigin: HOST_ORIGIN,
    bootId: 'boot-1',
    onFields: (fields) => {
      calls.push(fields);
      return {};
    },
  });
  // 未 start（未握手）就直接收到 fields-request。
  pair.parentViewOfFrame.postMessage(
    {
      channel: MESSAGE_CHANNEL,
      phase: 'fields-request',
      nonce: 'nobody',
      requestId: 'r-1',
      fields: FIELDS,
    },
    FORM_ORIGIN,
  );
  await settle();
  assert.equal(calls.length, 0);
  client.destroy();
});

test('超时拒绝后，迟到的 complete 被安全忽略', async () => {
  const harness = createHarness({ timeoutMs: 30 });
  harness.client.destroy(); // 表单不应答。

  const pending = harness.host.collect(FIELDS);
  await assert.rejects(pending, BridgeTimeoutError);

  const init = harness.postedToFrame[0] as { nonce: string };
  const request = harness.postedToFrame[1] as { requestId: string };
  harness.parent.dispatchMessage({
    origin: FORM_ORIGIN,
    source: harness.iframe.contentWindow,
    data: {
      channel: MESSAGE_CHANNEL,
      phase: 'complete',
      nonce: init.nonce,
      requestId: request.requestId,
      values: { email: 'too@late' },
    },
  });
  await settle();
  harness.host.destroy();
});

test('destroy 拒绝所有在途请求并停止监听', async () => {
  const harness = createHarness();
  const pending = harness.host.collect(FIELDS);
  const rejection = assert.rejects(pending, BridgeDestroyedError);
  harness.host.destroy();
  await rejection;
  await assert.rejects(harness.host.collect(FIELDS), BridgeDestroyedError);
  harness.client.destroy();
});
