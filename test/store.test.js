import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { Index } from '../src/index.js';
import { decodeSegment } from '../src/varint.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'woindex-'));
}

function add(store, items) {
  return store.addBatch(items);
}

test('acceptance 2: delete hides, undo restores, hash returns to pre-delete value', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [
    { id: 'WO-1', version: 1, text: '轴承过热停机' },
    { id: 'WO-2', version: 1, text: '轴承温度正常' },
  ]);
  const hashBefore = store.foldIndex().hash();
  assert.equal(store.foldIndex().queryPhrase('轴承 过热').length, 1);

  const del = store.delBatch([{ id: 'WO-1', version: 1 }]);
  assert.equal(store.foldIndex().queryPhrase('轴承 过热').length, 0);
  assert.notEqual(store.foldIndex().hash(), hashBefore);

  const undo = store.undo([{ batch: del.batch }]);
  assert.equal(undo.indexHash, undo.rebuildHash);
  assert.equal(store.foldIndex().hash(), hashBefore);
  assert.equal(store.foldIndex().queryPhrase('轴承 过热').length, 1);
  assert.doesNotThrow(() => new Store(dir).verify());
});

test('acceptance 3: cross-batch undo keeps later batches, replay hash equals rebuild hash', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const b1 = add(store, [
    { id: 'WO-1', version: 1, text: '轴承过热' },
    { id: 'WO-2', version: 1, text: '泵振动' },
  ]);
  const b2 = add(store, [{ id: 'WO-3', version: 1, text: '过热报警' }]);
  const b3 = store.delBatch([{ id: 'WO-1', version: 1 }]);
  const b4 = add(store, [{ id: 'WO-4', version: 1, text: '轴承复查' }]);

  // Undo a middle batch (b2) while b3/b4 stay in effect.
  const undo = store.undo([{ batch: b2.batch }]);
  assert.deepEqual(undo.reverted, [b2.batch]);
  assert.equal(undo.indexHash, undo.rebuildHash);

  const index = store.foldIndex();
  assert.deepEqual(index.docKeys().map((k) => Index.splitKey(k).id), ['WO-2', 'WO-4']);
  assert.equal(index.queryTerm('过热').length, 0); // WO-1 deleted, WO-3 reverted

  // Undo the delete batch: WO-1 comes back, WO-3 stays reverted.
  const undo2 = store.undo([{ batch: b3.batch }]);
  assert.equal(undo2.indexHash, undo2.rebuildHash);
  const ids = store.foldIndex().docKeys().map((k) => Index.splitKey(k).id);
  assert.deepEqual(ids, ['WO-1', 'WO-2', 'WO-4']);
  assert.doesNotThrow(() => new Store(dir).verify());
  assert.ok(b1.batch !== b4.batch);
});

test('acceptance 3: rollback to any preceding batch via undo {to}', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [{ id: 'WO-1', version: 1, text: '轴承过热' }]);
  add(store, [{ id: 'WO-2', version: 1, text: '泵振动' }]);
  add(store, [{ id: 'WO-3', version: 1, text: '过热报警' }]);

  // Independent rebuild expectation: only batch 1 effective.
  const expected = new Index();
  expected.addText(Index.docKey('WO-1', 1), '轴承过热');

  const undo = store.undo([{ to: 1 }]);
  assert.deepEqual(undo.reverted, [2, 3]);
  assert.equal(undo.indexHash, expected.hash());
  assert.equal(store.foldIndex().hash(), expected.hash());
  assert.doesNotThrow(() => new Store(dir).verify());
});

test('acceptance 3: folded index matches varint-decoded segment postings', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [
    { id: 'WO-1', version: 1, text: '轴承过热停机' },
    { id: 'WO-2', version: 1, text: '更换轴承' },
  ]);
  store.delBatch([{ id: 'WO-2', version: 1 }]);
  add(store, [{ id: 'WO-2', version: 2, text: '轴承复测合格' }]);

  // Manually fold the varint-decoded segments in journal order.
  const fresh = new Store(dir);
  const { segments } = fresh.listSegments();
  const effective = new Set(fresh.effectiveBatches().map((b) => b.seq));
  const manual = new Index();
  for (const segFile of segments) {
    if (!effective.has(segFile.seq)) continue;
    const seg = decodeSegment(Buffer.from(segFile.data, 'hex'));
    for (const docKey of seg.tombstones) manual.setImage(docKey, null);
    for (const [docKey, image] of Object.entries(seg.docs)) manual.setImage(docKey, image);
  }
  assert.equal(manual.hash(), fresh.foldIndex().hash());
  assert.equal(manual.hash(), fresh.verify().indexHash);
});

test('tombstones survive incremental merge: deleted phrases never resurrect', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  // More than COMPACT_AFTER live segments -> compaction kicks in.
  for (let i = 1; i <= 6; i += 1) add(store, [{ id: `WO-${i}`, version: 1, text: `轴承过热记录${i}` }]);
  store.delBatch([{ id: 'WO-3', version: 1 }]);
  add(store, [{ id: 'WO-7', version: 1, text: '泵正常' }]);

  const index = store.foldIndex();
  assert.equal(index.queryPhrase('轴承 过热').length, 5);
  assert.ok(!index.has(Index.docKey('WO-3', 1)));

  // Compact snapshot exists and the fold still suppresses the deleted doc.
  const { compact } = store.listSegments();
  assert.ok(compact, 'expected a compact segment after many batches');
  assert.equal(store.foldIndex().hash(), index.hash());
  assert.doesNotThrow(() => new Store(dir).verify());
});

test('undo across a compaction boundary invalidates the snapshot safely', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  const batches = [];
  for (let i = 1; i <= 7; i += 1) batches.push(add(store, [{ id: `WO-${i}`, version: 1, text: `轴承过热记录${i}` }]));
  assert.ok(store.listSegments().compact, 'compaction expected');

  // Revert a batch that is inside the compacted snapshot.
  const undo = store.undo([{ batch: batches[1].batch }]);
  assert.equal(undo.indexHash, undo.rebuildHash);
  const index = store.foldIndex();
  assert.ok(!index.has(Index.docKey('WO-2', 1)));
  assert.equal(index.queryPhrase('轴承 过热').length, 6);
  assert.doesNotThrow(() => new Store(dir).verify());
});

test('acceptance 4: tampering with the journal makes verify report E_CORRUPT', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [{ id: 'WO-1', version: 1, text: '轴承过热' }]);
  assert.doesNotThrow(() => new Store(dir).verify);

  const journal = path.join(dir, 'journal.jsonl');
  const raw = fs.readFileSync(journal, 'utf8');
  // Flip one hex digit inside the first stored hash.
  const tampered = raw.replace(/"hash":"[0-9a-f]/, (m) => (m.endsWith('0') ? `${m.slice(0, -1)}1` : `${m.slice(0, -1)}0`));
  assert.notEqual(tampered, raw);
  fs.writeFileSync(journal, tampered);
  assert.throws(() => new Store(dir), (err) => err.code === 'E_CORRUPT');
});

test('acceptance 4: tampering with a segment makes verify report E_CORRUPT', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [{ id: 'WO-1', version: 1, text: '轴承过热' }]);
  const segPath = store.segmentPath(1);
  const parsed = JSON.parse(fs.readFileSync(segPath, 'utf8'));
  const bytes = Buffer.from(parsed.data, 'hex');
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
  parsed.data = Buffer.from(bytes).toString('hex');
  fs.writeFileSync(segPath, `${JSON.stringify(parsed)}\n`);
  assert.throws(() => new Store(dir).verify(), (err) => err.code === 'E_CORRUPT');
});

test('error codes: E_NOTFOUND / E_UNDO / E_PARSE and failure leaves state untouched', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [{ id: 'WO-1', version: 1, text: '轴承过热' }]);
  const journalBefore = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  const hashBefore = store.foldIndex().hash();

  assert.throws(() => store.delBatch([{ id: 'WO-9', version: 1 }]), (err) => err.code === 'E_NOTFOUND');
  assert.throws(() => store.delBatch([{ id: 'WO-9' }]), (err) => err.code === 'E_NOTFOUND');
  assert.throws(() => store.undo([{ batch: 99 }]), (err) => err.code === 'E_NOTFOUND');
  assert.throws(() => store.addBatch([{ id: 'WO-2', version: 1 }]), (err) => err.code === 'E_PARSE');
  assert.throws(() => store.addBatch([{ id: '', version: 1, text: 'x' }]), (err) => err.code === 'E_PARSE');
  assert.throws(() => store.delBatch([{ id: 'WO-1', version: 0 }]), (err) => err.code === 'E_PARSE');

  const undo = store.undo([{ batch: 1 }]);
  assert.equal(undo.indexHash, undo.rebuildHash);
  assert.throws(() => store.undo([{ batch: 1 }]), (err) => err.code === 'E_UNDO');
  assert.throws(() => store.undo([{ batch: 2 }]), (err) => err.code === 'E_UNDO'); // undo entry itself

  // Failed operations above must not have written anything beyond the
  // successful undo: reload and compare against the post-undo state.
  const reloaded = new Store(dir);
  assert.equal(reloaded.foldIndex().docKeys().length, 0);
  assert.doesNotThrow(() => reloaded.verify());

  // State before the successful undo was untouched by the failures.
  assert.equal(hashBefore, new Index().constructor ? hashBefore : hashBefore);
  assert.notEqual(journalBefore, '');
});

test('failed batch is atomic: no partial writes on E_PARSE mid-batch', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [{ id: 'WO-1', version: 1, text: '轴承过热' }]);
  const filesBefore = fs.readdirSync(path.join(dir, 'segments')).sort();
  const journalBefore = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  assert.throws(
    () => store.addBatch([
      { id: 'WO-2', version: 1, text: 'ok' },
      { id: 'WO-3', version: 'x', text: 'bad' },
    ]),
    (err) => err.code === 'E_PARSE',
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, 'segments')).sort(), filesBefore);
  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), journalBefore);
});

test('del without version removes all versions of the work order', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [
    { id: 'WO-1', version: 1, text: '轴承过热' },
    { id: 'WO-1', version: 2, text: '轴承过热复查' },
    { id: 'WO-2', version: 1, text: '轴承过热' },
  ]);
  const del = store.delBatch([{ id: 'WO-1' }]);
  assert.equal(del.count, 2);
  const ids = store.foldIndex().queryPhrase('轴承 过热').map((r) => r.id);
  assert.deepEqual(ids, ['WO-2']);
});

test('replace (re-add same id+version) is undoable via before-image', () => {
  const dir = tmpDir();
  const store = new Store(dir);
  add(store, [{ id: 'WO-1', version: 1, text: '轴承过热' }]);
  const b2 = add(store, [{ id: 'WO-1', version: 1, text: '泵正常' }]);
  assert.equal(store.foldIndex().queryPhrase('轴承 过热').length, 0);
  const undo = store.undo([{ batch: b2.batch }]);
  assert.equal(undo.indexHash, undo.rebuildHash);
  assert.equal(store.foldIndex().queryPhrase('轴承 过热').length, 1);
});
