'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/engine');
const { Store, loadEngine } = require('../src/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vd-settle-'));
}

function buildEngine() {
  const e = new Engine();
  e.apply('calendar', { version: 'v1', holidays: [] });
  e.apply('trade', { id: 'T1', payCcy: 'EUR', payAmt: 100, recvCcy: 'USD', recvAmt: 110, valueDate: '2026-01-05' });
  e.apply('trade', { id: 'T2', payCcy: 'USD', payAmt: 110, recvCcy: 'EUR', recvAmt: 100, valueDate: '2026-01-05' });
  e.apply('trade', { id: 'T3', payCcy: 'EUR', payAmt: 40, recvCcy: 'USD', recvAmt: 44, valueDate: '2026-01-06' });
  e.apply('cancel', { id: 'T1' });
  e.apply('calendar', { version: 'v2', holidays: ['2026-01-06'] });
  e.apply('liquidity', { ccy: 'USD', amount: 500 });
  return e;
}

function persist(dir, engine) {
  const store = new Store(dir);
  for (const ev of engine.journal) store.append(ev);
  store.saveIndex(engine);
}

test('restart after crash mid queue-index update rebuilds a consistent index', () => {
  const dir = tmpdir();
  const engine = buildEngine();
  persist(dir, engine);
  const expectedHash = engine.stateHash();
  const expectedQueues = JSON.stringify(engine.queueSnapshot());

  fs.writeFileSync(path.join(dir, 'index.json'), '{"journalSeq":7,"queues":[["EUR/USD|2026-01-05"');

  const first = loadEngine(dir);
  assert.equal(first.rebuilt, true, 'torn index must be detected and rebuilt');
  assert.equal(first.engine.stateHash(), expectedHash);
  assert.equal(JSON.stringify(first.engine.queueSnapshot()), expectedQueues);

  const second = loadEngine(dir);
  assert.equal(second.rebuilt, false, 'rebuilt index must be stable across restarts');
  assert.equal(second.engine.stateHash(), expectedHash);
});

test('clean restart uses the persisted index without rebuild', () => {
  const dir = tmpdir();
  const engine = buildEngine();
  persist(dir, engine);
  const loaded = loadEngine(dir);
  assert.equal(loaded.rebuilt, false);
  assert.equal(loaded.engine.stateHash(), engine.stateHash());
  assert.equal(loaded.engine.proof().ok, true);
});

test('stale index behind the journal is rebuilt', () => {
  const dir = tmpdir();
  const engine = buildEngine();
  persist(dir, engine);
  const store = new Store(dir);
  const extra = engine.apply('liquidity', { ccy: 'EUR', amount: 10 });
  store.append(engine.journal[engine.journal.length - 1]);
  const loaded = loadEngine(dir);
  assert.equal(loaded.rebuilt, true);
  assert.equal(loaded.engine.stateHash(), engine.stateHash());
});
