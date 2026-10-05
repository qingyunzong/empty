'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const wip = require('../src/index.js');
const { tmpDir, cleanup } = require('./helpers.js');

function setup() {
  const dir = tmpDir();
  const store = new wip.Store(dir);
  wip.begin(store, { session: 'S1', node: 'A' });
  return { dir, store };
}

test('begin/scan/adjust/close lifecycle commits to ledger', () => {
  const { dir, store } = setup();
  try {
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 5 });
    wip.adjust(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', delta: -2 });
    const res = wip.close(store, { session: 'S1' });
    assert.equal(res.committed, 2);
    const state = store.loadState();
    assert.equal(state.inventory['A-01|ITM-0001'], 3);
    assert.equal(state.vv.A, 2);
    assert.equal(state.ops.length, 2);
    assert.deepEqual(state.closedSessions, ['S1']);
    assert.equal(store.loadSession('S1'), null);
  } finally { cleanup(dir); }
});

test('writes after close report CLOSED (exit 3)', () => {
  const { dir, store } = setup();
  try {
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 1 });
    wip.close(store, { session: 'S1' });
    for (const fn of [
      () => wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 1 }),
      () => wip.adjust(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', delta: 1 }),
    ]) {
      assert.throws(fn, (e) => e.code === 'CLOSED' && e.exitCode === 3);
    }
  } finally { cleanup(dir); }
});

test('barcode format and integer quantity validation (exit 2)', () => {
  const { dir, store } = setup();
  try {
    assert.throws(() => wip.scan(store, { session: 'S1', bin: 'a1', item: 'ITM-0001' }),
      (e) => e.code === 'INVALID_BARCODE' && e.exitCode === 2);
    assert.throws(() => wip.scan(store, { session: 'S1', bin: 'A-01', item: 'widget' }),
      (e) => e.code === 'INVALID_BARCODE' && e.exitCode === 2);
    assert.throws(() => wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 1.5 }),
      (e) => e.code === 'INVALID_QTY' && e.exitCode === 2);
    assert.throws(() => wip.adjust(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', delta: 0.5 }),
      (e) => e.code === 'INVALID_QTY' && e.exitCode === 2);
    assert.throws(() => wip.adjust(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', delta: 0 }),
      (e) => e.code === 'INVALID_QTY' && e.exitCode === 2);
  } finally { cleanup(dir); }
});

test('negative inventory boundary: down to zero ok, below zero rejected', () => {
  const { dir, store } = setup();
  try {
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 3 });
    wip.adjust(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', delta: -3 }); // exactly 0
    assert.throws(
      () => wip.adjust(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', delta: -1 }),
      (e) => e.code === 'NEGATIVE_INVENTORY' && e.exitCode === 2);
    wip.close(store, { session: 'S1' });
    assert.equal(store.loadState().inventory['A-01|ITM-0001'], 0);

    // ledger-level boundary: a new session cannot consume below committed stock
    wip.begin(store, { session: 'S2' });
    assert.throws(
      () => wip.adjust(store, { session: 'S2', bin: 'A-01', item: 'ITM-0001', delta: -1 }),
      (e) => e.code === 'NEGATIVE_INVENTORY');
    wip.scan(store, { session: 'S2', bin: 'A-01', item: 'ITM-0001', qty: 2 });
    wip.adjust(store, { session: 'S2', bin: 'A-01', item: 'ITM-0001', delta: -2 }); // back to 0
    wip.close(store, { session: 'S2' });
    assert.equal(store.loadState().inventory['A-01|ITM-0001'], 0);
    assert.equal(wip.verify(store).ok, true);
  } finally { cleanup(dir); }
});

test('undo allowed on open session only', () => {
  const { dir, store } = setup();
  try {
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 2 });
    const removed = wip.undo(store, { session: 'S1' });
    assert.equal(removed.delta, 2);
    assert.equal(store.loadSession('S1').ops.length, 0);
    assert.throws(() => wip.undo(store, { session: 'S1' }), (e) => e.code === 'NOTHING_TO_UNDO' && e.exitCode === 3);
    wip.scan(store, { session: 'S1', bin: 'A-01', item: 'ITM-0001', qty: 1 });
    wip.close(store, { session: 'S1' });
    assert.throws(() => wip.undo(store, { session: 'S1' }), (e) => e.code === 'CLOSED' && e.exitCode === 3);
    // undo of a never-existing session
    assert.throws(() => wip.undo(store, { session: 'NOPE' }), (e) => e.code === 'SESSION_NOT_FOUND' && e.exitCode === 3);
  } finally { cleanup(dir); }
});
