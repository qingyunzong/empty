import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, remaining } from '../src/state.js';
import { book } from '../src/ops.js';
import { bruteForceMinMakespan } from '../src/scheduler.js';

const makespan = (st) => st.segments.reduce((m, s) => Math.max(m, s.start + s.fields), 0);

function plan(st, specs) {
  for (const s of specs) st = book(st, s);
  return st;
}

test('验收1: n<=10 调度完工时间等于枚举最小完工', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const objectives = ['20x', '40x', '63x'];
  const channels = ['DAPI', 'GFP', 'RFP', 'Cy5'];
  for (const n of [1, 2, 3, 5, 8, 10]) {
    const specs = [];
    for (let i = 0; i < n; i++) {
      specs.push({
        id: 'b' + i,
        group: 'g' + (i % 3),
        objective: objectives[Math.floor(rnd() * 3)],
        channels: [channels[Math.floor(rnd() * 4)]],
        fields: 1 + Math.floor(rnd() * 5),
        priority: 0,
      });
    }
    const st = plan(createState(), specs);
    const opt = bruteForceMinMakespan(st.config, specs);
    assert.equal(makespan(st), opt, `n=${n} 应达到枚举最小完工`);
  }
});

test('验收3: 同优先级同配额按批 ID 排序', () => {
  const mk = (id) => ({ id, group: 'g', objective: '20x', channels: ['DAPI'], fields: 2, priority: 1 });
  const st = plan(createState(), [mk('b3'), mk('b1'), mk('b10'), mk('b2')]);
  assert.deepEqual(st.segments.map((s) => s.batchId), ['b1', 'b2', 'b3', 'b10']);
});

test('优先级支配批 ID', () => {
  const mk = (id, priority) => ({ id, group: 'g', objective: '20x', channels: ['DAPI'], fields: 2, priority });
  const st = plan(createState(), [mk('b1', 0), mk('b2', 5), mk('b3', 0)]);
  assert.deepEqual(st.segments.map((s) => s.batchId), ['b2', 'b1', 'b3']);
});

test('物镜聚类最小化切换成本', () => {
  const mk = (id, objective) => ({ id, group: 'g', objective, channels: ['DAPI'], fields: 3, priority: 0 });
  const st = plan(createState(), [mk('b1', '20x'), mk('b2', '40x'), mk('b3', '20x')]);
  assert.deepEqual(st.segments.map((s) => s.batchId), ['b1', 'b3', 'b2']);
  assert.equal(makespan(st), 9 + st.config.switchCost);
});

test('防抖动: 限制同组连续抢占次数', () => {
  const mk = (id, group) => ({ id, group, objective: '20x', channels: ['DAPI'], fields: 1, priority: 0 });
  const st = plan(createState(), [mk('a1', 'A'), mk('a2', 'A'), mk('a3', 'A'), mk('c1', 'C')]);
  // maxConsecutive=2：A 连续两次后须让位给 C
  assert.deepEqual(st.segments.map((s) => s.batchId), ['a1', 'a2', 'c1', 'a3']);
});

test('最久未服务课题组优先', async () => {
  const { scan } = await import('../src/ops.js');
  const mk = (id, group) => ({ id, group, objective: '20x', channels: ['DAPI'], fields: 2, priority: 0 });
  let st = plan(createState(), [mk('a1', 'A'), mk('b1', 'B')]);
  st = scan(st, 2); // A 组先被服务
  st = book(st, mk('a2', 'A'));
  st = book(st, mk('b2', 'B'));
  // B 组最久未服务，应排最前
  assert.equal(st.segments[0].batchId, 'b1');
});
