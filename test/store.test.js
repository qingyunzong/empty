import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PackStore } from '../src/store.js';
import { memStore, tmpdir, writePack } from './helpers.mjs';

test('load reads evidence.jsonl and evidence/*.json, keeps rules on reload', () => {
  const dir = tmpdir();
  writePack(dir, [
    { key: 'a1', attrs: { type: 'kyc' } },
    { key: 'a2', state: 'unknown', attrs: { type: 'kyc' } },
  ]);
  fs.mkdirSync(path.join(dir, 'evidence'));
  fs.writeFileSync(path.join(dir, 'evidence', 'extra.json'), JSON.stringify({ key: 'b1', attrs: { n: 1 } }));
  let store = PackStore.loadDir(dir);
  assert.equal(store.evidence.size, 3);
  assert.equal(store.getState('a2'), 'unknown');
  store.addRule({ id: 'r1', priority: 1, where: [{ field: 'type', op: 'eq', value: 'kyc' }] });
  store.save();
  // reload: evidence rebuilt from dir, rules preserved from store
  store = PackStore.loadDir(dir);
  assert.equal(store.rules.length, 1);
  assert.equal(store.ruleVersion, 1);
  assert.equal(store.evidence.size, 3);
});

test('duplicate evidence key is rejected', () => {
  const dir = tmpdir();
  writePack(dir, [{ key: 'a' }, { key: 'a' }]);
  assert.throws(() => PackStore.loadDir(dir), /duplicate evidence key/);
});

test('addRule: E_DUP_RULE on duplicate id, version bumps', () => {
  const store = memStore([{ key: 'a', attrs: { t: 'x' } }]);
  store.addRule({ id: 'r1', priority: 5, where: [] });
  assert.equal(store.ruleVersion, 1);
  assert.throws(() => store.addRule({ id: 'r1' }), (e) => e.code === 'E_DUP_RULE');
  assert.equal(store.ruleVersion, 1);
});

test('retract: E_EVIDENCE_GONE for missing or already-retracted key', () => {
  const store = memStore([{ key: 'a', attrs: {} }, { key: 'b', attrs: {}, state: 'retracted' }]);
  assert.throws(() => store.retract('nope'), (e) => e.code === 'E_EVIDENCE_GONE');
  assert.throws(() => store.retract('b'), (e) => e.code === 'E_EVIDENCE_GONE');
  store.retract('a');
  assert.throws(() => store.retract('a'), (e) => e.code === 'E_EVIDENCE_GONE');
});

test('retract is incremental: zero row scans, no rule re-matching', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ key: `k${i}`, attrs: { cat: `c${i % 5}` } });
  const store = memStore(rows, [
    { id: 'r1', priority: 1, where: [{ field: 'cat', op: 'eq', value: 'c1' }] },
    { id: 'r2', priority: 1, where: [{ field: 'cat', op: 'eq', value: 'c3' }] },
  ]);
  const evalsBefore = store.stats.ruleMatchEvals;
  const r = store.retract('k11'); // cat c1 -> rule r1 only
  assert.equal(r.scannedRows, 0);
  assert.deepEqual(r.affectedRules, ['r1']);
  assert.equal(store.stats.ruleMatchEvals, evalsBefore); // no rule re-evaluation
  assert.equal(store.getState('k11'), 'retracted');
});

test('equality claims use the inverted index instead of a full scan', () => {
  const rows = [];
  for (let i = 0; i < 500; i++) rows.push({ key: `k${i}`, attrs: { cat: `c${i % 25}` } });
  const store = memStore(rows);
  const { keys, scanned } = store.candidates([{ field: 'cat', op: 'eq', value: 'c7' }]);
  assert.equal(keys.length, 20);
  assert.ok(scanned <= 20, `expected index-served lookup, scanned ${scanned}`);
  const full = store.candidates([{ field: 'cat', op: 'ne', value: 'c7' }]);
  assert.equal(full.scanned, 500); // non-eq falls back to scan
});

test('inputHash changes on retract and on rule add', () => {
  const store = memStore([{ key: 'a', attrs: { x: 1 } }]);
  const h0 = store.inputHash();
  store.addRule({ id: 'r1', priority: 0, where: [] });
  const h1 = store.inputHash();
  assert.notEqual(h0, h1);
  store.retract('a');
  assert.notEqual(store.inputHash(), h1);
});
