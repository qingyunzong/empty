'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PositionalIndex, IndexError } = require('../src/index');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pidx-'));
}

test('phrase query with positional index', () => {
  const ix = new PositionalIndex(tmpdir());
  ix.addDoc('a', 'the quick brown fox jumps');
  ix.addDoc('b', 'quick brown fox');
  ix.addDoc('c', 'brown quick fox');
  assert.deepEqual(ix.phrase('quick brown fox').results, ['a', 'b']);
  assert.deepEqual(ix.phrase('brown quick').results, ['c']);
  assert.deepEqual(ix.phrase('fox quick').results, []);
  assert.deepEqual(ix.phrase('missing').results, []);
});

test('near query: shortest window, ties broken by smallest id', () => {
  const ix = new PositionalIndex(tmpdir());
  ix.addDoc('t9', 'foo bar');
  ix.addDoc('t2', 'foo bar');
  ix.addDoc('t5', 'foo x x x bar');
  const { results, certificate } = ix.near('foo', 'bar', 5);
  assert.deepEqual(results, [
    { id: 't2', window: 1 },
    { id: 't9', window: 1 },
    { id: 't5', window: 4 },
  ]);
  assert.equal(results[0].id, 't2'); // equal shortest window -> smallest id
  assert.deepEqual(certificate.segments, [1]);
  assert.equal(typeof certificate.hash, 'string');
});

test('tombstone delete reduces phrase results; unknown and duplicate delete error', () => {
  const ix = new PositionalIndex(tmpdir());
  ix.addDoc('d1', 'alice pays bob');
  ix.addDoc('d2', 'alice pays bob');
  assert.equal(ix.phrase('alice pays bob').results.length, 2);
  ix.deleteDoc('d1');
  assert.deepEqual(ix.phrase('alice pays bob').results, ['d2']);
  assert.throws(() => ix.deleteDoc('nope'), (e) => e.code === 'UNKNOWN_DOC');
  assert.throws(() => ix.deleteDoc('d1'), (e) => e.code === 'DUPLICATE_DELETE');
});

test('compaction rewrites segment past dead threshold; restart keeps results and hash', () => {
  const dir = tmpdir();
  const ix = new PositionalIndex(dir, { compactThreshold: 0.5 });
  for (let i = 1; i <= 4; i += 1) ix.addDoc(`d${i}`, `common phrase here doc${i}`);
  const before = ix.phrase('common phrase here');
  const hashBefore = ix.hash();

  ix.deleteDoc('d1');
  ix.deleteDoc('d2');
  assert.equal(ix.stats()[0].dead, 2); // 2/4 = 0.5 not over threshold yet
  const r = ix.deleteDoc('d3'); // 3/4 = 0.75 > 0.5 -> compact
  assert.ok(r.compacted, 'compaction should trigger');
  assert.equal(ix.stats().length, 1);
  assert.equal(ix.stats()[0].dead, 0);
  assert.notEqual(ix.stats()[0].id, 1); // rewritten as a new segment

  const after = ix.phrase('common phrase here');
  assert.equal(after.results.length, before.results.length - 3);
  assert.deepEqual(after.results, ['d4']);

  // restart from disk
  const ix2 = new PositionalIndex(dir, { compactThreshold: 0.5 });
  assert.deepEqual(ix2.phrase('common phrase here').results, after.results);
  assert.equal(ix2.hash(), ix.hash());
  // hash of live content unchanged by compaction itself (only deletions change it)
  assert.notEqual(ix.hash(), hashBefore);
  const ix3 = new PositionalIndex(dir, { compactThreshold: 0.5 });
  assert.equal(ix3.phrase('common phrase here').certificate.hash,
    ix2.phrase('common phrase here').certificate.hash);
});

test('certificate names the compressed segments used', () => {
  const dir = tmpdir();
  const ix = new PositionalIndex(dir, { compactThreshold: 0.99 });
  ix.addDoc('x1', 'alpha beta');
  ix.deleteDoc('x1');
  ix.addDoc('x2', 'alpha beta gamma');
  ix.compact(); // force a second segment generation
  ix.addDoc('x3', 'alpha beta');
  const { results, certificate } = ix.phrase('alpha beta');
  assert.deepEqual(results.sort(), ['x2', 'x3']);
  assert.ok(certificate.segments.length >= 1);
  const liveSegIds = ix.stats().map((s) => s.id);
  for (const id of certificate.segments) assert.ok(liveSegIds.includes(id));
});

test('duplicate doc id rejected', () => {
  const ix = new PositionalIndex(tmpdir());
  ix.addDoc('a', 'hello');
  assert.throws(() => ix.addDoc('a', 'world'), (e) => e.code === 'DUPLICATE_DOC');
});
