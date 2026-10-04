import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/gate.js';
import { parse, hashAst } from '../src/expr.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
}

const baseConfig = () => ({
  derived: { ratio: 'a / b' },
  windows: { w: { size: 100, hop: 10, bounds: '(]' } },
  rules: [
    { id: 'temp_max', expr: 'temp <= 100' },
    { id: 'ratio_ok', expr: 'ratio < 2' },
    { id: 'avg_ok', expr: 'avg(v) over w <= 50' },
  ],
  exemptions: [],
});

test('init rejects invalid rule expression with E_RULE', () => {
  const config = baseConfig();
  config.rules[0].expr = 'temp <=';
  assert.throws(() => Store.init(tmpHome(), config), (e) => e.code === 'E_RULE');
});

test('init rejects unknown window reference with E_WINDOW', () => {
  const config = baseConfig();
  config.rules[2].expr = 'avg(v) over nope <= 50';
  assert.throws(() => Store.init(tmpHome(), config), (e) => e.code === 'E_WINDOW');
});

test('init rejects malformed window definitions with E_WINDOW', () => {
  for (const w of [
    { size: -5 },
    { size: 100, bounds: '<>' },
    { size: 100, hop: 7 },
    { size: 0 },
  ]) {
    const config = baseConfig();
    config.windows = { w };
    config.rules = [{ id: 'r', expr: 'avg(v) over w <= 1' }];
    assert.throws(() => Store.init(tmpHome(), config), (e) => e.code === 'E_WINDOW', JSON.stringify(w));
  }
});

test('init rejects exemption referencing unknown rule with E_EXEMPT', () => {
  const config = baseConfig();
  config.exemptions = [{ id: 'x', priority: 1, rules: ['nope'] }];
  assert.throws(() => Store.init(tmpHome(), config), (e) => e.code === 'E_EXEMPT');
});

test('pass decision and certificate contents', () => {
  const store = Store.init(tmpHome(), baseConfig());
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 80, a: 4, b: 4, v: 10 } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'pass');
  assert.deepEqual(cert.violations, []);
  assert.deepEqual(cert.undecided, []);
  assert.equal(cert.evaluations.length, 3);
  const tempEv = cert.evaluations.find((e) => e.ruleId === 'temp_max');
  assert.equal(tempEv.result, true);
  assert.equal(tempEv.astHash, hashAst(parse('temp <= 100')));
  assert.deepEqual(cert.windowKeys, ['w:-50:50:(]']);
  assert.match(cert.rulesHash, /^[0-9a-f]{64}$/);
  assert.equal(cert.seq, 1);
});

test('derived metric participates in rules', () => {
  const store = Store.init(tmpHome(), baseConfig());
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 80, a: 10, b: 2, v: 10 } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'fail');
  assert.deepEqual(cert.violations, ['ratio_ok']);
});

test('fail decision records violations', () => {
  const store = Store.init(tmpHome(), baseConfig());
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 150, a: 4, b: 4, v: 10 } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'fail');
  assert.deepEqual(cert.violations, ['temp_max']);
  assert.equal(cert.evaluations.find((e) => e.ruleId === 'temp_max').result, false);
});

test('unknown metric yields undecided, never fail', () => {
  const store = Store.init(tmpHome(), baseConfig());
  store.addObs({ key: 'o1', ts: 50, metrics: { a: 4, b: 4, v: 10 } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'undecided');
  assert.notEqual(cert.decision, 'fail');
  assert.deepEqual(cert.violations, []);
  assert.deepEqual(cert.undecided, ['temp_max']);
  assert.equal(cert.evaluations.find((e) => e.ruleId === 'temp_max').result, null);
});

test('derived metric with missing input is undecided, not fail', () => {
  const store = Store.init(tmpHome(), baseConfig());
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 80, a: 4, v: 10 } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'undecided');
  assert.deepEqual(cert.undecided, ['ratio_ok']);
});

test('exemption with highest priority wins and is recorded in the chain', () => {
  const config = baseConfig();
  config.exemptions = [
    { id: 'low', priority: 1, rules: ['temp_max'], when: "site == 'A'" },
    { id: 'high', priority: 10, rules: ['temp_max'], when: "site == 'A'" },
  ];
  const store = Store.init(tmpHome(), config);
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 150, a: 4, b: 4, v: 10, site: 'A' } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'pass');
  assert.equal(cert.exemptionChain.length, 1);
  assert.equal(cert.exemptionChain[0].id, 'high');
  assert.equal(cert.exemptionChain[0].priority, 10);
  assert.deepEqual(cert.exemptionChain[0].contenders, ['low', 'high']);
  const tempEv = cert.evaluations.find((e) => e.ruleId === 'temp_max');
  assert.equal(tempEv.result, false);
  assert.equal(tempEv.exempted, true);
  assert.equal(tempEv.exemption.id, 'high');
});

test('exemption priority tie raises E_EXEMPT', () => {
  const config = baseConfig();
  config.exemptions = [
    { id: 'x1', priority: 5, rules: ['temp_max'] },
    { id: 'x2', priority: 5, rules: ['temp_max'] },
  ];
  const store = Store.init(tmpHome(), config);
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 150, a: 4, b: 4, v: 10 } });
  assert.throws(() => new Engine(store).decide('o1'), (e) => e.code === 'E_EXEMPT');
});

test('exemption outside its time range does not apply', () => {
  const config = baseConfig();
  config.exemptions = [{ id: 'x1', priority: 5, rules: ['temp_max'], from: 100, until: 200 }];
  const store = Store.init(tmpHome(), config);
  store.addObs({ key: 'o1', ts: 50, metrics: { temp: 150, a: 4, b: 4, v: 10 } });
  const cert = new Engine(store).decide('o1');
  assert.equal(cert.decision, 'fail');
  assert.deepEqual(cert.exemptionChain, []);
});

test('correction invalidates only overlapping windows and stays consistent with full replay', () => {
  const home = tmpHome();
  const store = Store.init(home, {
    windows: { w: { size: 100, hop: 10, bounds: '(]' } },
    rules: [{ id: 'avg_ok', expr: 'avg(v) over w <= 50' }],
  });
  for (let t = 55; t <= 145; t += 5) store.addObs({ key: `k${t}`, ts: t, metrics: { v: 1 } });
  store.addObs({ key: 'far', ts: 300, metrics: { v: 1 } });

  const before = new Engine(store).decide('k145'); // window (45,145]
  assert.equal(before.decision, 'pass');
  new Engine(store).decide('far'); // window (200,300]
  const bucketsBefore = structuredClone(store.state.caches.buckets);
  assert.ok(bucketsBefore.w['10'], 'bucket 10 cached before correction');
  assert.ok(bucketsBefore.w['21'], 'far bucket cached before correction');

  store.correct('k100', { metrics: { v: 5000 } });

  const bucketsAfter = store.state.caches.buckets;
  assert.ok(!bucketsAfter.w['10'], 'bucket containing corrected ts invalidated');
  assert.deepEqual(bucketsAfter.w['6'], bucketsBefore.w['6'], 'non-overlapping bucket untouched');
  assert.deepEqual(bucketsAfter.w['21'], bucketsBefore.w['21'], 'far bucket untouched');
  assert.ok(!store.state.caches.queries['w:45:145:(]'], 'overlapping window query invalidated');
  assert.ok(store.state.caches.queries['w:200:300:(]'], 'non-overlapping window query retained');

  const after = new Engine(store).decide('k145');
  assert.equal(after.decision, 'fail');
  assert.deepEqual(after.violations, ['avg_ok']);

  // correction that moves an observation in time invalidates both old and new positions
  store.correct('k60', { ts: 1000 });
  assert.ok(!store.state.caches.buckets.w['6'], 'old position bucket invalidated');
  assert.ok(!store.state.caches.buckets.w['100'], 'new position bucket invalidated');

  // incremental state must agree with a full replay from the event log
  const fresh = Store.rebuild(home);
  const engFresh = new Engine(fresh);
  const engLive = new Engine(store);
  assert.ok(fresh.state.order.length > 0);
  for (const key of fresh.state.order) {
    assert.deepEqual(engLive.decide(key), engFresh.decide(key), `certificate mismatch for ${key}`);
  }
});

test('decide on unknown key raises E_INPUT; duplicate obs key rejected', () => {
  const store = Store.init(tmpHome(), baseConfig());
  store.addObs({ key: 'o1', ts: 1, metrics: {} });
  assert.throws(() => new Engine(store).decide('nope'), (e) => e.code === 'E_INPUT');
  assert.throws(() => store.addObs({ key: 'o1', ts: 2, metrics: {} }), (e) => e.code === 'E_INPUT');
  assert.throws(() => store.correct('nope', { metrics: {} }), (e) => e.code === 'E_INPUT');
});
