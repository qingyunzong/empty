import test from 'node:test';
import assert from 'node:assert/strict';
import { runAll } from '../src/index.js';

const SRC = `
customer C1001;
note_whitelist /^REQ-[0-9]+$/;
bucket loan limit 1000;
`;

const byId = (state) =>
  Object.fromEntries(state.log.filter((l) => l.seq !== null).map((l) => [l.id, l]));

test('边界: 冻结等于可用额 -> 成功, 可用归零', () => {
  const events = [
    { id: 'f1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 1000, note: 'REQ-1', until: '2026-12-01' },
  ];
  const { state } = runAll(SRC, events);
  assert.equal(byId(state).f1.status, 'ok');
  assert.deepEqual(
    { ...state.buckets.get('loan') },
    { limit: 1000, available: 0, frozen: 1000, used: 0 },
  );
});

test('边界: 超可用 1 元 -> E_CAP 且不得部分扣减', () => {
  const events = [
    { id: 'f1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 1001, note: 'REQ-1', until: '2026-12-01' },
  ];
  const { state } = runAll(SRC, events);
  assert.equal(byId(state).f1.code, 'E_CAP');
  assert.deepEqual(
    { ...state.buckets.get('loan') },
    { limit: 1000, available: 1000, frozen: 0, used: 0 },
  );
});

test('边界: 到期日 00:00 生效 — 前一秒可用, 当日 00:00 已过期', () => {
  const events = [
    { id: 'f1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 600, note: 'REQ-1', until: '2026-10-05' },
    { id: 'd1', ts: '2026-10-04T23:59:59Z', type: 'draw', bucket: 'loan', ref: 'REQ-1', amount: 100 },
    { id: 'd2', ts: '2026-10-05T00:00:00Z', type: 'draw', bucket: 'loan', ref: 'REQ-1', amount: 100 },
    { id: 'u1', ts: '2026-10-05T00:00:01Z', type: 'unfreeze', bucket: 'loan', ref: 'REQ-1', amount: 500 },
  ];
  const { state } = runAll(SRC, events);
  const log = byId(state);
  assert.equal(log.d1.status, 'ok'); // 到期前最后一秒仍可动用
  assert.equal(log.d2.code, 'E_EXPIRED'); // 到期日 00:00 批量结算后已过期
  assert.equal(log.u1.code, 'E_EXPIRED');
  const b = state.buckets.get('loan');
  // 到期批量释放未使用部分 500, used 保留 100
  assert.deepEqual({ ...b }, { limit: 1000, available: 900, frozen: 0, used: 100 });
  const expire = state.log.find((l) => l.type === 'expire');
  assert.equal(expire.day, '2026-10-05');
  assert.equal(expire.released, 500);
});

test('边界: 负解冻 -> E_CAP, 状态不变', () => {
  const events = [
    { id: 'f1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 500, note: 'REQ-1', until: '2026-12-01' },
    { id: 'u1', ts: '2026-10-02T09:00:00Z', type: 'unfreeze', bucket: 'loan', ref: 'REQ-1', amount: -100 },
  ];
  const { state } = runAll(SRC, events);
  assert.equal(byId(state).u1.code, 'E_CAP');
  assert.deepEqual(
    { ...state.buckets.get('loan') },
    { limit: 1000, available: 500, frozen: 500, used: 0 },
  );
});

test('解冻只能释放未使用冻结', () => {
  const events = [
    { id: 'f1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 800, note: 'REQ-1', until: '2026-12-01' },
    { id: 'd1', ts: '2026-10-02T09:00:00Z', type: 'draw', bucket: 'loan', ref: 'REQ-1', amount: 300 },
    { id: 'u1', ts: '2026-10-03T09:00:00Z', type: 'unfreeze', bucket: 'loan', ref: 'REQ-1', amount: 800 },
  ];
  const { state } = runAll(SRC, events);
  const log = byId(state);
  assert.equal(log.u1.status, 'ok');
  assert.equal(log.u1.released, 500); // 只释放未使用的 500, 不是 800
  assert.deepEqual(
    { ...state.buckets.get('loan') },
    { limit: 1000, available: 700, frozen: 0, used: 300 },
  );
});

test('draw 超过未使用冻结 -> E_CAP 不得部分扣减', () => {
  const events = [
    { id: 'f1', ts: '2026-10-01T09:00:00Z', type: 'freeze', bucket: 'loan', amount: 500, note: 'REQ-1', until: '2026-12-01' },
    { id: 'd1', ts: '2026-10-02T09:00:00Z', type: 'draw', bucket: 'loan', ref: 'REQ-1', amount: 400 },
    { id: 'd2', ts: '2026-10-02T10:00:00Z', type: 'draw', bucket: 'loan', ref: 'REQ-1', amount: 200 },
  ];
  const { state } = runAll(SRC, events);
  assert.equal(byId(state).d2.code, 'E_CAP');
  assert.deepEqual(
    { ...state.buckets.get('loan') },
    { limit: 1000, available: 500, frozen: 100, used: 400 },
  );
});
