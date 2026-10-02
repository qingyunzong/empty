import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Simple reference implementation: plain maps, no WAL, no files.
class RefStore {
  constructor() {
    this.committed = new Map();
    this.txs = new Map(); // id -> { id, parent, ops: Map, status }
    this.done = new Map(); // committed txId -> { kind, target, sets }
    this.undoStack = [];
    this.redoStack = [];
    this.nextId = 1;
  }

  err(code) {
    const e = new Error(code);
    e.code = code;
    return e;
  }

  begin(parentId = null) {
    if (parentId != null) this._open(parentId);
    const id = this.nextId++;
    this.txs.set(id, { id, parent: parentId, ops: new Map(), status: 'open' });
    return id;
  }

  _open(id) {
    const tx = this.txs.get(id);
    if (!tx || tx.status !== 'open') throw this.err('CLOSED');
    return tx;
  }

  set(id, k, v) {
    this._open(id).ops.set(k, { hasValue: true, value: v });
  }

  del(id, k) {
    this._open(id).ops.set(k, { hasValue: false, value: undefined });
  }

  get(id, k) {
    for (let tx = this._open(id); tx; tx = this.txs.get(tx.parent)) {
      if (tx.ops.has(k)) {
        const op = tx.ops.get(k);
        return { found: op.hasValue, value: op.value };
      }
    }
    return { found: this.committed.has(k), value: this.committed.get(k) };
  }

  _abortOpenDescendants(id) {
    for (const t of this.txs.values()) {
      if (t.status !== 'open') continue;
      for (let p = t.parent; p != null; p = this.txs.get(p)?.parent) {
        if (p === id) {
          t.status = 'aborted';
          break;
        }
      }
    }
  }

  commit(id) {
    const tx = this._open(id);
    this._abortOpenDescendants(id);
    tx.status = 'committed';
    if (tx.parent != null && this.txs.get(tx.parent)?.status === 'open') {
      const parent = this.txs.get(tx.parent);
      for (const [k, op] of tx.ops) parent.ops.set(k, op);
      return;
    }
    const sets = new Map();
    for (const [k, op] of tx.ops) {
      sets.set(k, {
        hasValue: op.hasValue,
        value: op.value,
        hasPrev: this.committed.has(k),
        prev: this.committed.get(k),
      });
    }
    this._apply({ id, kind: 'normal', target: null, sets });
  }

  abort(id) {
    const tx = this._open(id);
    this._abortOpenDescendants(id);
    tx.status = 'aborted';
  }

  _apply(rec) {
    for (const [k, s] of rec.sets) {
      if (s.hasValue) this.committed.set(k, s.value);
      else this.committed.delete(k);
    }
    this.done.set(rec.id, rec);
    if (rec.kind === 'normal') {
      this.undoStack.push(rec.id);
      this.redoStack = [];
    } else if (rec.kind === 'undo') {
      this.undoStack = this.undoStack.filter((x) => x !== rec.target);
      this.redoStack.push(rec.target);
    } else {
      this.redoStack = this.redoStack.filter((x) => x !== rec.target);
      this.undoStack.push(rec.target);
    }
  }

  undo(txId) {
    const id = txId ?? this.undoStack[this.undoStack.length - 1];
    if (id === undefined || !this.undoStack.includes(id)) {
      throw this.err('NOTHING_TO_UNDO');
    }
    const t = this.done.get(id);
    for (const [k, s] of t.sets) {
      const curHas = this.committed.has(k);
      if (curHas !== s.hasValue) throw this.err('CONFLICT');
      if (s.hasValue && JSON.stringify(this.committed.get(k)) !== JSON.stringify(s.value)) {
        throw this.err('CONFLICT');
      }
    }
    const sets = new Map();
    for (const [k, s] of t.sets) {
      sets.set(k, { hasValue: s.hasPrev, value: s.prev, hasPrev: s.hasValue, prev: s.value });
    }
    this._apply({ id: this.nextId++, kind: 'undo', target: id, sets });
  }

  redo(txId) {
    const id = txId ?? this.redoStack[this.redoStack.length - 1];
    if (id === undefined || !this.redoStack.includes(id)) {
      throw this.err('NOTHING_TO_REDO');
    }
    const t = this.done.get(id);
    for (const [k, s] of t.sets) {
      const curHas = this.committed.has(k);
      if (curHas !== s.hasPrev) throw this.err('CONFLICT');
      if (s.hasPrev && JSON.stringify(this.committed.get(k)) !== JSON.stringify(s.prev)) {
        throw this.err('CONFLICT');
      }
    }
    const sets = new Map();
    for (const [k, s] of t.sets) {
      sets.set(k, { hasValue: s.hasValue, value: s.value, hasPrev: s.hasPrev, prev: s.prev });
    }
    this._apply({ id: this.nextId++, kind: 'redo', target: id, sets });
  }

  openIds() {
    return [...this.txs.values()].filter((t) => t.status === 'open').map((t) => t.id);
  }
}

const KEYS = ['a', 'b', 'c', 'd', 'e'];

function runSeed(seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-fuzz-'));
  let store = new Store(dir);
  const ref = new RefStore();
  const realTxs = new Map(); // ref txId -> real Transaction

  const code = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e.code || `BUG:${e.message}`;
    }
  };

  const checkState = (op) => {
    assert.deepEqual(store.snapshot(), Object.fromEntries(ref.committed), `snapshot after ${op} (seed ${seed})`);
    assert.deepEqual(store.undoStack, ref.undoStack, `undoStack after ${op} (seed ${seed})`);
    assert.deepEqual(store.redoStack, ref.redoStack, `redoStack after ${op} (seed ${seed})`);
  };

  for (let step = 0; step < 250; step++) {
    const open = ref.openIds();
    const roll = rand();
    let op;
    if (roll < 0.12 || open.length === 0) {
      op = 'begin';
      const id = ref.begin();
      realTxs.set(id, store.begin());
    } else if (roll < 0.22) {
      const pid = pick(open);
      op = `sub(${pid})`;
      const id = ref.begin(pid);
      realTxs.set(id, realTxs.get(pid).begin());
    } else if (roll < 0.45) {
      const id = pick(open);
      const k = pick(KEYS);
      const v = Math.floor(rand() * 10);
      op = `set(${id},${k},${v})`;
      ref.set(id, k, v);
      realTxs.get(id).set(k, v);
    } else if (roll < 0.5) {
      const id = pick(open);
      const k = pick(KEYS);
      op = `del(${id},${k})`;
      ref.del(id, k);
      realTxs.get(id).del(k);
    } else if (roll < 0.65) {
      const id = pick(open);
      op = `commit(${id})`;
      ref.commit(id);
      realTxs.get(id).commit();
    } else if (roll < 0.75) {
      const id = pick(open);
      op = `abort(${id})`;
      ref.abort(id);
      realTxs.get(id).abort();
    } else if (roll < 0.8) {
      const id = pick(open);
      const k = pick(KEYS);
      op = `get(${id},${k})`;
      const expected = ref.get(id, k);
      const got = realTxs.get(id).get(k);
      assert.deepEqual(
        { found: got !== undefined, value: got },
        { found: expected.found && expected.value !== undefined, value: expected.value },
        `get mismatch at ${op} (seed ${seed})`,
      );
    } else if (roll < 0.9) {
      const useId = ref.undoStack.length > 0 && rand() < 0.4;
      const target = useId ? pick(ref.undoStack) : undefined;
      op = `undo(${target})`;
      const rc = code(() => ref.undo(target));
      const sc = code(() => store.undo(target));
      assert.equal(sc, rc, `undo error mismatch at ${op} (seed ${seed})`);
    } else if (roll < 0.97) {
      const useId = ref.redoStack.length > 0 && rand() < 0.4;
      const target = useId ? pick(ref.redoStack) : undefined;
      op = `redo(${target})`;
      const rc = code(() => ref.redo(target));
      const sc = code(() => store.redo(target));
      assert.equal(sc, rc, `redo error mismatch at ${op} (seed ${seed})`);
    } else {
      op = 'reopen';
      store.close();
      store = new Store(dir);
      // Open in-memory transactions are lost on restart; drop them in the ref too.
      for (const t of ref.txs.values()) if (t.status === 'open') t.status = 'aborted';
      realTxs.clear();
      // Ids of never-committed txs are forgotten across restart.
      ref.nextId = store._nextTxId;
    }
    checkState(`${op} @step ${step}`);
  }
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('random nested operations match the reference implementation', () => {
  for (let seed = 1; seed <= 40; seed++) runSeed(seed);
});
