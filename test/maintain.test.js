import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, imagedRuns } from '../src/state.js';
import { book, scan, maintain } from '../src/ops.js';
import { gapBetween } from '../src/scheduler.js';
import { proofOf } from '../src/util.js';
import { validateTimeline } from './helpers.js';

function setup() {
  let st = createState();
  st = book(st, { id: 'b1', group: 'g1', objective: '20x', channels: ['GFP'], fields: 4, priority: 0 });
  st = book(st, { id: 'b2', group: 'g2', objective: '20x', channels: ['RFP'], fields: 4, priority: 0 });
  st = book(st, { id: 'b3', group: 'g3', objective: '40x', channels: ['DAPI'], fields: 3, priority: 0 });
  return st;
}

test('验收2: 维护撤销时段后迁移不侵犯通道互斥', () => {
  let st = setup();
  st = scan(st, 3);
  const imagedBefore = JSON.stringify(st.imaged);
  st = maintain(st, 4, 8);
  validateTimeline(st);
  for (const sg of st.segments) {
    assert.ok(sg.start + sg.fields <= 4 || sg.start >= 8, '迁移后段不得落在维护窗口');
  }
  assert.equal(JSON.stringify(st.imaged), imagedBefore, '已出具图像不可改');
});

test('维护重叠报错 exit 10', () => {
  let st = setup();
  st = maintain(st, 4, 8);
  assert.throws(() => maintain(st, 6, 10), (e) => e.code === 'MAINTENANCE_OVERLAP' && e.exitCode === 10);
});

test('维护覆盖已出具图像失败', () => {
  let st = setup();
  st = scan(st, 5);
  assert.throws(() => maintain(st, 2, 6), (e) => e.code === 'IMMUTABLE');
});

test('迁移不可行时明确失败并回滚到上一代际', () => {
  let st = createState({ horizon: 12 });
  st = book(st, { id: 'b1', group: 'g1', objective: '20x', channels: ['DAPI'], fields: 5, priority: 0 });
  st = book(st, { id: 'b2', group: 'g2', objective: '40x', channels: ['GFP'], fields: 5, priority: 0 });
  const before = proofOf(st);
  const genBefore = st.generation;
  assert.throws(() => maintain(st, 0, 4), (e) => e.code === 'MIGRATION_FAILED');
  assert.equal(proofOf(st), before, '失败后状态应停留在原代际');
  assert.equal(st.generation, genBefore);
});

test('层级回滚以批代际为单位，已出具图像不可改', async () => {
  const { rollbackTo } = await import('../src/ops.js');
  let st = createState();
  st = book(st, { id: 'b1', group: 'g1', objective: '20x', channels: ['DAPI'], fields: 3, priority: 0 });
  const gen1 = st.generation;
  st = scan(st, 2); // 出具 2 视野图像
  st = book(st, { id: 'b2', group: 'g2', objective: '40x', channels: ['GFP'], fields: 3, priority: 0 });
  st = rollbackTo(st, gen1); // 回滚到 gen1 的调度视图
  assert.ok(!st.batches.b2, '回滚撤销后续批次');
  assert.equal(st.imaged.length, 2, '已出具图像保留');
  assert.equal(st.batches.b1.fieldsImaged, 2);
  validateTimeline(st);
  assert.throws(() => rollbackTo(st, 999), (e) => e.code === 'NO_GENERATION');
});
