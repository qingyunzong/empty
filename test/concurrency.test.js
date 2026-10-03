import test from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/index.js';

const SRC = `
customer C1001;
note_whitelist /^REQ-[0-9]+$/;
bucket loan limit 1000;
`;

const mk = (id, note) => ({
  id,
  ts: '2026-10-01T09:00:00Z',
  type: 'freeze',
  bucket: 'loan',
  amount: 1000,
  note,
  until: '2026-12-01',
});

test('并发同额同时刻: 确定性 tie-break, 只有一个成功', () => {
  const a = mk('req-a', 'REQ-1');
  const b = mk('req-b', 'REQ-2');

  const run1 = runAll(SRC, [a, b]).state;
  const run2 = runAll(SRC, [b, a]).state; // 打乱输入顺序, 结果必须一致

  for (const state of [run1, run2]) {
    const log = Object.fromEntries(state.log.map((l) => [l.id, l]));
    assert.equal(log['req-a'].status, 'ok'); // id 字典序胜出
    assert.equal(log['req-b'].code, 'E_CAP'); // 超可用, 整体拒绝
    assert.deepEqual(
      { ...state.buckets.get('loan') },
      { limit: 1000, available: 0, frozen: 1000, used: 0 },
    );
  }
});

test('同一时刻多事件全序确定: (ts, id, 行号)', () => {
  const events = [
    mk('req-c', 'REQ-3'),
    mk('req-a', 'REQ-1'),
    mk('req-b', 'REQ-2'),
  ];
  const { state } = runAll(SRC, events);
  const order = state.log.filter((l) => l.seq !== null).map((l) => l.id);
  assert.deepEqual(order, ['req-a', 'req-b', 'req-c']);
});
