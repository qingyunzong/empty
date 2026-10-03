import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

const V1 = `
version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    threshold max_amount: money = 1000.00;
    rule r_amount { when event.amount > max_amount then deny }
  }
}`;

const V2 = `
version "v2" since "2024-06-01T00:00:00Z" {
  scope global {
    threshold max_amount: money = 100.00;
    rule r_amount { when event.amount > max_amount then deny }
  }
}`;

const oldEvent = {
  id: 'old',
  time: '2024-03-01T00:00:00Z',
  merchant: 'MCH1',
  channel: 'alipay',
  ip: '10.0.0.1',
  amount: 500,
  count: 1,
};

const newEvent = { ...oldEvent, id: 'new', time: '2024-07-01T00:00:00Z' };

test('hot update keeps historical events on their original rule version', () => {
  const engine = new Engine();
  engine.loadSource(V1);

  const before = engine.evaluate(oldEvent);
  assert.equal(before.version, 'v1');
  assert.equal(before.decision, 'ALLOW'); // 500 < 1000 under v1

  engine.loadSource(V2); // hot update tightens the threshold to 100

  const after = engine.evaluate(oldEvent);
  assert.deepEqual(after, before); // replay is stable for old events

  const fresh = engine.evaluate(newEvent);
  assert.equal(fresh.version, 'v2');
  assert.equal(fresh.decision, 'DENY'); // 500 > 100 under v2
});

test('reloading the same version id is rejected', () => {
  const engine = new Engine();
  engine.loadSource(V1);
  assert.throws(() => engine.loadSource(V1), (e) => e.code === 'E_VERSION');
});

test('versions can be loaded out of order and still route by event time', () => {
  const engine = new Engine();
  engine.loadSource(V2);
  engine.loadSource(V1);
  assert.equal(engine.evaluate(oldEvent).version, 'v1');
  assert.equal(engine.evaluate(newEvent).version, 'v2');
});
