import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apply, initialState, buildIndex, MachineError, EXIT,
} from '../src/machine.js';

// ---------- independent reference state machine (for enumeration) ----------
function refInitial() {
  return { def: {}, ord: {}, ordDefects: {}, tomb: new Set() };
}
function refApply(s, op) {
  const st = structuredClone(s, { transfer: [] });
  st.tomb = new Set(s.tomb);
  const bad = (m) => { throw new Error(m); };
  if (op.type === 'open') {
    if (st.tomb.has(op.defectId)) bad('tombstone');
    if (st.def[op.defectId]) bad('exists');
    st.def[op.defectId] = 'open';
  } else if (op.type === 'rework') {
    if (st.ord[op.orderId]) bad('order exists');
    for (const d of op.defectIds) {
      if (!st.def[d]) bad('no defect');
      if (st.tomb.has(d)) bad('tombstone');
      if (st.def[d] !== 'open') bad('not open');
    }
    for (const d of op.defectIds) st.def[d] = 'in_rework';
    st.ord[op.orderId] = 'open';
    st.ordDefects[op.orderId] = [...op.defectIds];
  } else if (op.type === 'close') {
    if (st.ord[op.orderId] !== 'open') bad('not open');
    st.ord[op.orderId] = 'closed';
    for (const d of st.ordDefects[op.orderId]) {
      if (op.result === 'pass') st.def[d] = 'closed';
      else if (op.result === 'fail') st.def[d] = 'open';
      else { st.def[d] = 'scrapped'; st.tomb.add(d); }
    }
  } else {
    bad('unknown');
  }
  return st;
}
function sameVisible(lib, ref) {
  const libDef = Object.fromEntries(
    Object.values(lib.defects).map((d) => [d.id, d.status]),
  );
  assert.deepEqual(libDef, ref.def);
  const libOrd = Object.fromEntries(
    Object.values(lib.orders).map((o) => [o.id, o.status]),
  );
  assert.deepEqual(libOrd, ref.ord);
}

const ALPHABET = [
  { type: 'open', defectId: 'd1' },
  { type: 'open', defectId: 'd2' },
  { type: 'rework', orderId: 'r1', defectIds: ['d1'] },
  { type: 'rework', orderId: 'r2', defectIds: ['d2'] },
  { type: 'rework', orderId: 'r3', defectIds: ['d1', 'd2'] },
  { type: 'close', orderId: 'r1', result: 'pass' },
  { type: 'close', orderId: 'r1', result: 'fail' },
  { type: 'close', orderId: 'r1', result: 'scrap' },
  { type: 'close', orderId: 'r2', result: 'pass' },
  { type: 'close', orderId: 'r2', result: 'scrap' },
  { type: 'close', orderId: 'r3', result: 'pass' },
  { type: 'close', orderId: 'r3', result: 'fail' },
];

function stepBoth(lib, ref, op) {
  let libErr = null;
  let refErr = null;
  let libNext = null;
  let refNext = null;
  try { libNext = apply(structuredClone(lib), op); } catch (e) { libErr = e; }
  try { refNext = refApply(ref, op); } catch (e) { refErr = e; }
  assert.equal(!libErr, !refErr,
    `error mismatch for ${JSON.stringify(op)}: lib=${libErr?.message} ref=${refErr?.message}`);
  if (!libErr) sameVisible(libNext, refNext);
  return { lib: libNext ?? lib, ref: refNext ?? ref };
}

test('acceptance 4: exhaustive enumeration (depth<=3) matches reference machine', () => {
  let checked = 0;
  const dfs = (lib, ref, depth) => {
    if (depth === 0) return;
    for (const op of ALPHABET) {
      const next = stepBoth(lib, ref, op);
      checked += 1;
      dfs(next.lib, next.ref, depth - 1);
    }
  };
  dfs(initialState(), refInitial(), 3);
  assert.ok(checked > 1000, `expected >1000 enumerated steps, got ${checked}`);
});

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('acceptance 4: seeded random walks of 12 ops match reference machine', () => {
  const rand = mulberry32(20261003);
  for (let walk = 0; walk < 300; walk += 1) {
    let lib = initialState();
    let ref = refInitial();
    for (let i = 0; i < 12; i += 1) { // sequences capped at <=12 operations
      const op = ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const next = stepBoth(lib, ref, op);
      lib = next.lib;
      ref = next.ref;
    }
  }
});

// ---------- acceptance 2: scrap tombstone ----------
test('acceptance 2: scrapped defect can never be reworked or reopened', () => {
  const s = initialState();
  apply(s, { type: 'open', defectId: 'd1' });
  apply(s, { type: 'rework', orderId: 'r1', defectIds: ['d1'] });
  apply(s, { type: 'close', orderId: 'r1', result: 'scrap' });
  assert.equal(s.defects.d1.status, 'scrapped');
  assert.ok(s.tombstones.d1);
  assert.throws(() => apply(s, { type: 'rework', orderId: 'r2', defectIds: ['d1'] }),
    /tombstone/);
  assert.throws(() => apply(s, { type: 'open', defectId: 'd1' }), /tombstone/);
  assert.equal(s.defects.d1.status, 'scrapped'); // unchanged
});

// ---------- acceptance 3: correction propagates only to affected sequence ----------
test('acceptance 3: re-inspection correction hits only the affected sequence', () => {
  const s = initialState();
  apply(s, { type: 'open', defectId: 'd1' });                    // n1
  apply(s, { type: 'open', defectId: 'd2' });                    // n2
  apply(s, { type: 'rework', orderId: 'r1', defectIds: ['d1'] }); // n3
  apply(s, { type: 'close', orderId: 'r1', result: 'fail' });     // n4
  apply(s, { type: 'rework', orderId: 'r2', defectIds: ['d1'] }); // n5
  apply(s, { type: 'close', orderId: 'r2', result: 'pass' });     // n6
  apply(s, { type: 'rework', orderId: 'r3', defectIds: ['d2'] }); // n7
  apply(s, { type: 'close', orderId: 'r3', result: 'pass' });     // n8
  const d2SeqBefore = [...s.defects.d2.seq];

  apply(s, { type: 'correct', orderId: 'r1', result: 'pass' });   // n9

  const corr = s.corrections.at(-1);
  assert.deepEqual(corr.impactSet, ['n5', 'n6']); // only d1's downstream sequence
  assert.equal(s.defects.d1.status, 'closed');    // recomputed along d1
  assert.equal(s.defects.d2.status, 'closed');    // untouched
  assert.deepEqual(s.defects.d2.seq, d2SeqBefore); // unrelated sequence intact
  assert.equal(s.orders.r1.result, 'pass');
});

test('correction to scrap tombstones only affected defects', () => {
  const s = initialState();
  apply(s, { type: 'open', defectId: 'd1' });
  apply(s, { type: 'open', defectId: 'd2' });
  apply(s, { type: 'rework', orderId: 'r1', defectIds: ['d1'] });
  apply(s, { type: 'close', orderId: 'r1', result: 'pass' });
  apply(s, { type: 'rework', orderId: 'r2', defectIds: ['d2'] });
  apply(s, { type: 'close', orderId: 'r2', result: 'pass' });
  apply(s, { type: 'correct', orderId: 'r1', result: 'scrap' });
  assert.equal(s.defects.d1.status, 'scrapped');
  assert.ok(s.tombstones.d1);
  assert.equal(s.defects.d2.status, 'closed');
  assert.ok(!s.tombstones.d2);
});

// ---------- undo rules ----------
test('undo of open/rework nodes works pre-close and leaves audit', () => {
  const s = initialState();
  apply(s, { type: 'open', defectId: 'd1' });                     // n1
  apply(s, { type: 'open', defectId: 'd2' });                     // n2
  apply(s, { type: 'rework', orderId: 'r1', defectIds: ['d2'] }); // n3
  apply(s, { type: 'undo', nodeId: 'n3', reason: 'wrong order' });
  assert.equal(s.defects.d2.status, 'open');
  assert.equal(s.orders.r1, undefined);
  apply(s, { type: 'undo', nodeId: 'n1' });
  assert.equal(s.defects.d1, undefined);
  assert.equal(s.audits.length, 2);
  assert.deepEqual(s.audits.map((a) => a.undoOf), ['n3', 'n1']);
  assert.ok(s.nodes.n3.undone && s.nodes.n1.undone);
});

test('undo after close exits 21 (closed loop cannot be undone)', () => {
  const s = initialState();
  apply(s, { type: 'open', defectId: 'd1' });
  apply(s, { type: 'rework', orderId: 'r1', defectIds: ['d1'] });
  apply(s, { type: 'close', orderId: 'r1', result: 'pass' });
  for (const nid of ['n3', 'n2', 'n1']) {
    assert.throws(() => apply(s, { type: 'undo', nodeId: nid }), (e) => {
      assert.ok(e instanceof MachineError);
      assert.equal(e.code, EXIT.UNDO_AFTER_CLOSE);
      return true;
    });
  }
  assert.equal(s.audits.length, 0);
});

test('index is derived from state (counts match exactly)', () => {
  const s = initialState();
  apply(s, { type: 'open', defectId: 'd1' });
  apply(s, { type: 'open', defectId: 'd2' });
  apply(s, { type: 'rework', orderId: 'r1', defectIds: ['d1'] });
  apply(s, { type: 'close', orderId: 'r1', result: 'scrap' });
  const idx = buildIndex(s);
  assert.deepEqual(idx.defectsByStatus, { open: 1, scrapped: 1 });
  assert.deepEqual(idx.ordersByStatus, { closed: 1 });
  assert.equal(idx.tombstones, 1);
});
