import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fee-journal-'));
}

test('crash mid-invoice-write recovers without double billing', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'invoices.jsonl');

  const j1 = new Journal(file);
  assert.equal(j1.append({ key: '2026-10-03:A', amount: 350 }), true);
  assert.equal(j1.append({ key: '2026-10-03:B', amount: 100 }), true);
  j1.close();

  fs.appendFileSync(file, '{"key":"2026-10-03:C","amou');

  const j2 = new Journal(file);
  assert.equal(j2.has('2026-10-03:A'), true);
  assert.equal(j2.has('2026-10-03:B'), true);
  assert.equal(j2.has('2026-10-03:C'), false);
  assert.equal(j2.append({ key: '2026-10-03:A', amount: 350 }), false);
  assert.equal(j2.append({ key: '2026-10-03:C', amount: 40 }), true);
  j2.close();

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.key), ['2026-10-03:A', '2026-10-03:B', '2026-10-03:C']);

  const j3 = new Journal(file);
  assert.equal(j3.append({ key: '2026-10-03:C', amount: 40 }), false);
  j3.close();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
});

test('corrupt tail line is truncated on recovery', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'invoices.jsonl');
  const j1 = new Journal(file);
  j1.append({ key: 'k1', amount: 1 });
  j1.close();
  fs.appendFileSync(file, 'not-json-at-all\n{"key":"k2"');
  const j2 = new Journal(file);
  assert.equal(j2.has('k1'), true);
  assert.equal(j2.has('k2'), false);
  assert.equal(j2.append({ key: 'k2', amount: 2 }), true);
  j2.close();
  const keys = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
  assert.deepEqual(keys, ['k1', 'k2']);
});
