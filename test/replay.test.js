import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleStore } from '../src/store.js';

const V1 = `version 1
valid_from 2026-01-01T00:00:00Z
rule g level global { deny when amount > 10000CNY }`;
const V2 = `version 2
valid_from 2026-06-01T00:00:00Z
rule g level global { deny when amount > 5000CNY }`;

test('acceptance 3: after hot update, old events still replay under old version', () => {
  const store = new RuleStore();
  store.loadSource(V1);
  const event = { id: 'e', ts: '2026-03-01T00:00:00Z', amount: 8000, currency: 'CNY' };
  assert.equal(store.evaluate(event).outcome, 'allow');
  store.loadSource(V2); // hot update
  const replayed = store.evaluate(event);
  assert.equal(replayed.version, 1);
  assert.equal(replayed.outcome, 'allow');
  const fresh = store.evaluate({ id: 'e2', ts: '2026-07-01T00:00:00Z', amount: 8000, currency: 'CNY' });
  assert.equal(fresh.version, 2);
  assert.equal(fresh.outcome, 'deny');
});

test('E_VERSION: event before any version, duplicate version, unknown version', () => {
  const store = new RuleStore();
  store.loadSource(V1);
  assert.throws(() => store.evaluate({ ts: '2020-01-01T00:00:00Z' }), /E_VERSION/);
  assert.throws(() => store.loadSource(V1), /E_VERSION/);
  assert.throws(() => store.evaluate({ ts: '2026-03-01T00:00:00Z' }, { version: 99 }), /E_VERSION/);
  assert.throws(() => store.evaluate({ ts: 'not-a-date' }), /E_VERSION/);
});

test('explicit --version style evaluation pins the ruleset', () => {
  const store = new RuleStore();
  store.loadSource(V1);
  store.loadSource(V2);
  const event = { ts: '2026-07-01T00:00:00Z', amount: 8000, currency: 'CNY' };
  assert.equal(store.evaluate(event, { version: 1 }).outcome, 'allow');
  assert.equal(store.evaluate(event, { version: 2 }).outcome, 'deny');
});
