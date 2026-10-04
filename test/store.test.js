import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, StoreError } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtx-'));
}

test('scenario 1: aborting the middle of 3 nesting levels removes only that layer', () => {
  const s = new Store(tmpdir());
  const t1 = s.begin();
  s.set(t1, 'a', '1');
  const t2 = s.begin(t1);
  s.set(t2, 'b', '2');
  const t3 = s.begin(t2);
  s.set(t3, 'c', '3');
  const sib = s.begin(t1); // sibling of t2
  s.set(sib, 's', '9');

  s.abort(t2); // aborts t2 and its child t3

  assert.equal(s.get('a', t1), '1');
  assert.equal(s.get('b', t1), undefined);
  assert.equal(s.get('c', t1), undefined);
  assert.equal(s.get('s', sib), '9'); // sibling unaffected
  assert.throws(() => s.set(t3, 'x', 'y'), (e) => e.code === 'CLOSED');

  s.commit(sib); // merges into t1
  s.commit(t1);  // outermost: hits WAL
  assert.equal(s.get('a'), '1');
  assert.equal(s.get('s'), '9');
  assert.equal(s.get('b'), undefined);
  assert.equal(s.get('c'), undefined);
  s.close();
});

test('scenario 2: undo then redo restores the exact post-commit state', () => {
  const s = new Store(tmpdir());
  const t1 = s.begin();
  s.set(t1, 'x', '1');
  s.commit(t1);
  const t2 = s.begin();
  s.set(t2, 'x', '2');
  s.set(t2, 'y', '3');
  s.commit(t2);

  const committed = new Map(s.data);
  s.undo();
  assert.equal(s.get('x'), '1');
  assert.equal(s.get('y'), undefined);
  s.undo();
  assert.equal(s.get('x'), undefined);
  s.redo();
  s.redo();
  assert.deepEqual([...s.data.entries()].sort(), [...committed.entries()].sort());
  s.close();
});

test('scenario 3: crash between undo WAL record and completion marker is all-or-nothing', () => {
  const dir = tmpdir();
  const s = new Store(dir);
  const t = s.begin();
  s.set(t, 'k', 'v');
  s.commit(t);
  s.close();

  // crash: undo record written, completion marker not written
  const crashed = new Store(dir);
  assert.throws(() => crashed.undo(null, { crashBeforeEnd: true }), (e) => e.code === 'CRASH');
  crashed.close();

  // recover: the undo must not exist at all
  const r = new Store(dir);
  assert.equal(r.get('k'), 'v');
  assert.equal(r.undoStack.length, 1);
  assert.equal(r.redoStack.length, 0);

  // redo chain continues: undo again, reload, then redo
  r.undo();
  assert.equal(r.get('k'), undefined);
  r.close();
  const r2 = new Store(dir);
  assert.equal(r2.get('k'), undefined); // completed undo fully applied
  assert.equal(r2.redoStack.length, 1);
  r2.redo();
  assert.equal(r2.get('k'), 'v');
  r2.close();

  // crash before the record even lands: also fully absent
  const r3 = new Store(dir);
  assert.throws(() => r3.undo(null, { crashBeforeBegin: true }), (e) => e.code === 'CRASH');
  r3.close();
  const r4 = new Store(dir);
  assert.equal(r4.get('k'), 'v');
  assert.equal(r4.undoStack.length, 1);
  r4.close();
});

test('error codes: NOTHING_TO_UNDO, CLOSED, CONFLICT', () => {
  const s = new Store(tmpdir());
  assert.throws(() => s.undo(), (e) => e.code === 'NOTHING_TO_UNDO');

  const t = s.begin();
  s.set(t, 'k', '1');
  s.commit(t);
  assert.throws(() => s.abort(t), (e) => e.code === 'CLOSED');
  assert.throws(() => s.commit(t), (e) => e.code === 'CLOSED');

  const t2 = s.begin();
  s.set(t2, 'k', '2');
  s.commit(t2);
  // undoing the older tx conflicts with the newer write on the same key
  assert.throws(() => s.undo(t), (e) => e.code === 'CONFLICT');
  assert.equal(s.get('k'), '2'); // conflict: nothing executed
  assert.equal(s.redoStack.length, 0);
  s.close();
});

test('undo/redo history survives restart', () => {
  const dir = tmpdir();
  const s = new Store(dir);
  const t1 = s.begin();
  s.set(t1, 'a', '1');
  s.commit(t1);
  const t2 = s.begin();
  s.set(t2, 'b', '2');
  s.commit(t2);
  s.undo();
  s.close();

  const r = new Store(dir);
  assert.equal(r.undoStack.length, 1);
  assert.equal(r.redoStack.length, 1);
  assert.equal(r.get('b'), undefined);
  r.redo();
  assert.equal(r.get('b'), '2');
  r.close();
});

// simple reference model: stack of write-maps + snapshot history for undo/redo
class Ref {
  constructor() {
    this.hist = [new Map()];
    this.idx = 0;
    this.stack = [];
  }
  begin() { this.stack.push(new Map()); }
  set(k, v) { this.stack[this.stack.length - 1].set(k, v); }
  commit() {
    const top = this.stack.pop();
    if (this.stack.length > 0) {
      for (const [k, v] of top) this.stack[this.stack.length - 1].set(k, v);
    } else {
      const next = new Map(this.hist[this.idx]);
      for (const [k, v] of top) next.set(k, v);
      this.hist = this.hist.slice(0, this.idx + 1);
      this.hist.push(next);
      this.idx++;
    }
  }
  abort() { this.stack.pop(); }
  undo() { if (this.idx > 0) this.idx--; }
  redo() { if (this.idx < this.hist.length - 1) this.idx++; }
  get(k) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].has(k)) return this.stack[i].get(k);
    }
    return this.hist[this.idx].get(k);
  }
  committed() { return this.hist[this.idx]; }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random nested operations match a simple reference implementation', () => {
  const rand = mulberry32(42);
  const keys = ['k1', 'k2', 'k3', 'k4'];
  const s = new Store(tmpdir());
  const ref = new Ref();
  const open = []; // stack of tx ids mirroring ref.stack

  for (let step = 0; step < 3000; step++) {
    const r = rand();
    if (r < 0.25) {
      const id = s.begin(open.length ? open[open.length - 1] : null);
      open.push(id);
      ref.begin();
    } else if (r < 0.55 && open.length) {
      const k = keys[Math.floor(rand() * keys.length)];
      const v = `v${step}`;
      s.set(open[open.length - 1], k, v);
      ref.set(k, v);
    } else if (r < 0.7 && open.length) {
      s.commit(open.pop());
      ref.commit();
    } else if (r < 0.8 && open.length) {
      s.abort(open.pop());
      ref.abort();
    } else if (r < 0.87 && open.length === 0 && ref.idx > 0) {
      s.undo();
      ref.undo();
    } else if (r < 0.94 && open.length === 0 && ref.idx < ref.hist.length - 1) {
      s.redo();
      ref.redo();
    } else {
      const k = keys[Math.floor(rand() * keys.length)];
      const txId = open.length ? open[open.length - 1] : null;
      assert.equal(s.get(k, txId), ref.get(k), `get(${k}) at step ${step}`);
    }
  }
  while (open.length) { s.commit(open.pop()); ref.commit(); }
  assert.deepEqual(
    [...s.data.entries()].sort(),
    [...ref.committed().entries()].sort(),
  );
  s.close();
});
