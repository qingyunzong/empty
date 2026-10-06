import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event-bus.js';

test('subscriptions added during publish only affect later publishes', () => {
  const bus = new EventBus();
  const calls: string[] = [];
  bus.subscribe('t', () => {
    calls.push('a');
    bus.subscribe('t', () => {
      calls.push('b');
    });
  });
  bus.publish('t', null);
  assert.deepEqual(calls, ['a']);
  bus.publish('t', null);
  assert.deepEqual(calls, ['a', 'a', 'b']);
});

test('removal during publish does not affect the in-flight snapshot', () => {
  const bus = new EventBus();
  const calls: string[] = [];
  const victim = bus.subscribe('t', () => {
    calls.push('victim');
  });
  bus.subscribe('t', () => {
    calls.push('remover');
    victim.remove();
  });
  bus.publish('t', null);
  // The snapshot was fixed at publish start: the removed callback still ran.
  assert.deepEqual(calls, ['victim', 'remover']);
  bus.publish('t', null);
  // The next publish observes the removal.
  assert.deepEqual(calls, ['victim', 'remover', 'remover']);
});

test('one subscription runs exactly once per publish, even with reentrant publish', () => {
  const bus = new EventBus();
  const invocations = new Map<string, number>();
  let depth = 0;
  bus.subscribe('t', (_payload, ctx) => {
    const key = `${ctx.publishId}:${ctx.subscription.id}`;
    invocations.set(key, (invocations.get(key) ?? 0) + 1);
    if (depth < 3) {
      depth += 1;
      bus.publish('t', null); // reentrant publish of the same topic
      depth -= 1;
    }
  });
  bus.publish('t', null);
  // 4 publishes happened (depths 0..3), the single subscription ran once in each.
  assert.equal(invocations.size, 4);
  for (const [key, count] of invocations) {
    assert.equal(count, 1, `subscription invoked ${count} times in ${key}`);
  }
});

test('re-subscribing inside a callback does not extend the current snapshot', () => {
  const bus = new EventBus();
  let calls = 0;
  const self = bus.subscribe('t', () => {
    calls += 1;
    if (calls === 1) {
      self.remove();
      bus.subscribe('t', () => {
        calls += 100;
      });
    }
  });
  bus.publish('t', null);
  assert.equal(calls, 1);
  bus.publish('t', null);
  assert.equal(calls, 101);
});

test('snapshot order follows subscription order', () => {
  const bus = new EventBus();
  const calls: string[] = [];
  for (const name of ['c', 'a', 'b']) {
    bus.subscribe('t', () => {
      calls.push(name);
    });
  }
  bus.publish('t', null);
  assert.deepEqual(calls, ['c', 'a', 'b']);
});
