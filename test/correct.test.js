import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/state.js';
import { book, scan, correct, cancel } from '../src/ops.js';
import { validateTimeline } from './helpers.js';

test('减少视野须释放机时', () => {
  let st = createState();
  st = book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: 6, priority: 0 });
  st = book(st, { id: 'b2', group: 'g', objective: '20x', channels: ['DAPI'], fields: 4, priority: 0 });
  const b2Before = st.segments.filter((s) => s.batchId === 'b2');
  st = correct(st, 'b1', -3);
  const b1Segs = st.segments.filter((s) => s.batchId === 'b1');
  assert.equal(b1Segs.reduce((m, s) => m + s.fields, 0), 3);
  assert.deepEqual(st.segments.filter((s) => s.batchId === 'b2'), b2Before, '他批机时不受影响');
  validateTimeline(st);
});

test('增加视野只追加可行段', () => {
  let st = createState();
  st = book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: 2, priority: 0 });
  st = book(st, { id: 'b2', group: 'g', objective: '20x', channels: ['DAPI'], fields: 2, priority: 0 });
  const b2Before = st.segments.filter((s) => s.batchId === 'b2');
  st = correct(st, 'b1', 3);
  const b1Segs = st.segments.filter((s) => s.batchId === 'b1');
  assert.equal(b1Segs.reduce((m, s) => m + s.fields, 0), 5);
  assert.deepEqual(st.segments.filter((s) => s.batchId === 'b2'), b2Before, '追加不得移动他批');
  // 追加段在原批末段之后
  const added = b1Segs.filter((s) => s.start >= 2);
  assert.ok(added.length > 0 && added.every((s) => s.start >= 2));
  validateTimeline(st);
});

test('负视野 exit 10', () => {
  let st = createState();
  assert.throws(() => book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: -1, priority: 0 }),
    (e) => e.code === 'NEGATIVE_FIELDS' && e.exitCode === 10);
  st = book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: 3, priority: 0 });
  assert.throws(() => correct(st, 'b1', -4), (e) => e.code === 'NEGATIVE_FIELDS' && e.exitCode === 10);
});

test('更正不得触及已出具图像', () => {
  let st = createState();
  st = book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: 4, priority: 0 });
  st = scan(st, 3);
  assert.throws(() => correct(st, 'b1', -2), (e) => e.code === 'IMMUTABLE');
  st = correct(st, 'b1', -1); // 释放未成像部分可行
  assert.equal(st.batches.b1.fieldsTotal, 3);
});

test('撤销批次释放机时，已成像部分保留', () => {
  let st = createState();
  st = book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: 4, priority: 0 });
  st = scan(st, 2);
  st = cancel(st, 'b1');
  assert.equal(st.batches.b1.status, 'cancelled');
  assert.equal(st.segments.filter((s) => s.batchId === 'b1').length, 0);
  assert.equal(st.imaged.length, 2);
  assert.throws(() => cancel(st, 'b1'), (e) => e.code === 'UNKNOWN_BATCH');
});

test('全部成像后不可撤销', () => {
  let st = createState();
  st = book(st, { id: 'b1', group: 'g', objective: '20x', channels: ['DAPI'], fields: 2, priority: 0 });
  st = scan(st);
  assert.throws(() => cancel(st, 'b1'), (e) => e.code === 'IMMUTABLE');
});
