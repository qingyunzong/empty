import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { tmpdir, hashResults } from './helpers.js';

const EVENTS = [
  { id: 'e1', tradeId: 't1', fee: 30, refundBudget: 100, text: 'red green blue', state: 'open' },
  { id: 'e2', tradeId: 't1', fee: 20, refundBudget: 100, text: 'green blue yellow', state: 'open' },
  { id: 'e3', tradeId: 't2', fee: 5, refundBudget: 50, text: 'blue yellow black', state: 'open' },
  { id: 'e4', tradeId: 't2', fee: 7, refundBudget: 50, text: 'yellow black white', state: 'open' },
  { id: 'e5', tradeId: 't3', fee: 9, refundBudget: 90, text: 'black white red', state: 'open' },
];

function populate(dir) {
  const store = Store.open(dir, { mergeThreshold: 0 });
  for (const event of EVENTS) store.append(event);
  return store;
}

function snapshot(store) {
  return hashResults({
    live: store.liveEvents(),
    phrase: store.queryPhrase('green blue'),
    near: store.queryNear(['red', 'white'], 3),
    refunds: [...store.refunds.values()],
  });
}

test('corrupt manifest falls back to backup manifest and old segments', () => {
  const dir = tmpdir();
  const store = populate(dir);
  store.delete('e2');
  store.delete('e4');
  store.undoTrade('t3');
  store.merge();
  const before = snapshot(store);

  // Simulate a torn write of the committed manifest.
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"generation":2,"segments":["seg-0000');

  const recovered = Store.open(dir, { mergeThreshold: 0 });
  assert.equal(snapshot(recovered), before);
  assert.deepEqual(recovered.queryPhrase('green blue'), ['e1']);
  assert.equal(recovered.refunds.get('t3').amount, 9);
});

test('missing manifest and backup falls back to scanning old segments', () => {
  const dir = tmpdir();
  const store = populate(dir);
  store.delete('e3');
  const before = snapshot(store);

  fs.unlinkSync(path.join(dir, 'manifest.json'));
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.json.bak')));

  const recovered = Store.open(dir, { mergeThreshold: 0 });
  assert.equal(snapshot(recovered), before);
  assert.deepEqual(recovered.liveEvents().map((e) => e.id),
    ['e1', 'e2', 'e4', 'e5']);
});

test('half-written manifest and uncommitted segment are ignored on restart', () => {
  const dir = tmpdir();
  const store = populate(dir);
  store.delete('e1');
  const before = snapshot(store);
  const filesBefore = fs.readdirSync(dir).sort();

  // Simulate a crash mid-merge: partial new segment + half-written manifest tmp.
  fs.writeFileSync(path.join(dir, 'seg-000002.jsonl'), '{"id":"e2","tradeId":"t1","fee":20');
  fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{"generation":2,"seg');

  const recovered = Store.open(dir, { mergeThreshold: 0 });
  assert.equal(snapshot(recovered), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), filesBefore);
});

test('failed undo followed by restart preserves refunds log and index state', () => {
  const dir = tmpdir();
  let store = populate(dir);
  store.undoTrade('t1');
  assert.throws(() => store.undoTrade('ghost'), (err) => err.code === 'ERR_UNKNOWN_TRADE');
  const before = snapshot(store);

  store = Store.open(dir, { mergeThreshold: 0 });
  assert.equal(snapshot(store), before);
  const refunds = fs.readFileSync(path.join(dir, 'refunds.jsonl'), 'utf8').trim().split('\n');
  assert.equal(refunds.length, 1);
  assert.equal(JSON.parse(refunds[0]).tradeId, 't1');
});
