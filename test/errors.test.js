'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePair, keyOf, writeCsv, csvContent, callCli, callCliJson } = require('./helpers');
const { loadState } = require('../lib/state');

test('read-only target exits with code 60', (t) => {
  const { a, b } = makePair(t);
  const key = keyOf(0);
  writeCsv(a, key, csvContent('new', 0));

  fs.chmodSync(b, 0o555); // read-only target
  t.after(() => { try { fs.chmodSync(b, 0o755); } catch {} });

  const r = callCli(['apply', '--a', a, '--b', b]);
  assert.equal(r.code, 60);
  assert.match(r.err, /read-only target/);
  // Nothing was copied.
  assert.equal(fs.readdirSync(b).filter((f) => f.endsWith('.csv')).length, 0);
});

test('tombstone resurrection without new version exits with code 61', (t) => {
  const { a, b } = makePair(t);
  const key = keyOf(1);
  const content = csvContent('doomed', 1);
  writeCsv(a, key, content);
  writeCsv(b, key, content);
  callCliJson(['apply', '--a', a, '--b', b]); // establish state

  // Delete on both sides -> tombstone.
  fs.unlinkSync(path.join(a, require('../lib/keys').fileNameForKey(key)));
  callCliJson(['apply', '--a', a, '--b', b]);
  assert.equal(loadState(a).files[key].deleted, true);
  assert.equal(loadState(b).files[key].deleted, true);

  // Resurrect with the SAME content (no new version) -> error 61.
  writeCsv(a, key, content);
  const r = callCli(['diff', '--a', a, '--b', b]);
  assert.equal(r.code, 61);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].code, 61);
  assert.match(parsed.errors[0].message, /tombstone resurrection without new version/);

  // plan also surfaces the error with exit 61.
  const rp = callCli(['plan', '--a', a, '--b', b]);
  assert.equal(rp.code, 61);

  // Resurrect with a NEW version is allowed and propagates.
  writeCsv(a, key, csvContent('reborn', 2));
  const r2 = callCli(['diff', '--a', a, '--b', b]);
  assert.equal(r2.code, 0);
  const d2 = JSON.parse(r2.out);
  assert.equal(d2.errors.length, 0);
  assert.equal(d2.changes[0].reason, 'resurrected-in-a-new-version');
});
