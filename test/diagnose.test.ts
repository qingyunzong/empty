import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EVENT_KINDS,
  TERMINATION_CATEGORIES,
  TERMINATION_TABLE,
  diagnose,
  type ExecutionEvent,
} from '../src/index.js';

const ev = (partial: Partial<ExecutionEvent> & Pick<ExecutionEvent, 'id' | 'kind' | 'at'>): ExecutionEvent => partial;

test('有限表穷举核对：每个事件种类都有显式表项', () => {
  for (const kind of EVENT_KINDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(TERMINATION_TABLE, kind),
      `TERMINATION_TABLE 缺少种类 ${kind}`,
    );
  }
  assert.equal(Object.keys(TERMINATION_TABLE).length, EVENT_KINDS.length);
});

test('有限表穷举核对：非空表项均为合法终止类别，且每个类别可达', () => {
  const reachable = new Set<string>();
  for (const kind of EVENT_KINDS) {
    const category = TERMINATION_TABLE[kind];
    if (category !== null) {
      assert.ok(
        (TERMINATION_CATEGORIES as readonly string[]).includes(category),
        `种类 ${kind} 映射到非法类别 ${category}`,
      );
      reachable.add(category);
    }
  }
  for (const category of TERMINATION_CATEGORIES) {
    assert.ok(reachable.has(category), `类别 ${category} 无任何事件种类可达`);
  }
});

test('无执行证据：空事件流 -> unknown', () => {
  const result = diagnose([]);
  assert.equal(result.category, 'unknown');
  assert.equal(result.terminalEventId, null);
  assert.deepEqual(result.causalChain, []);
});

test('无执行证据：有事件但无终止证据 -> unknown', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'run_started', at: 1 }),
    ev({ id: 'b', kind: 'step_started', at: 2 }),
    ev({ id: 'c', kind: 'step_completed', at: 3 }),
  ]);
  assert.equal(result.category, 'unknown');
  assert.equal(result.terminalEventId, null);
});

test('无执行证据：终止种类事件但未标记 terminatesRun -> unknown', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'assertion_failed', at: 1 }),
  ]);
  assert.equal(result.category, 'unknown');
});

test('无执行证据：terminatesRun 标记在不可分类种类上 -> unknown', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'step_completed', at: 1, terminatesRun: true }),
  ]);
  assert.equal(result.category, 'unknown');
});

test('前置缺失分类', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'run_started', at: 1 }),
    ev({ id: 'b', kind: 'prerequisite_missing', at: 2, terminatesRun: true, causeIds: ['a'] }),
  ]);
  assert.equal(result.category, 'prerequisite_missing');
  assert.equal(result.terminalEventId, 'b');
});

test('通信中断分类', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'communication_lost', at: 10, terminatesRun: true }),
  ]);
  assert.equal(result.category, 'communication_interrupted');
});

test('断言失败分类', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'assertion_failed', at: 10, terminatesRun: true }),
  ]);
  assert.equal(result.category, 'assertion_failed');
});

test('多原因：按最早直接致终止事件定类', () => {
  const result = diagnose([
    ev({ id: 'late', kind: 'assertion_failed', at: 9, terminatesRun: true }),
    ev({ id: 'early', kind: 'communication_lost', at: 4, terminatesRun: true }),
    ev({ id: 'mid', kind: 'prerequisite_missing', at: 7, terminatesRun: true }),
  ]);
  assert.equal(result.category, 'communication_interrupted');
  assert.equal(result.terminalEventId, 'early');
});

test('多原因：时间戳相同按输入顺序取先者', () => {
  const result = diagnose([
    ev({ id: 'first', kind: 'assertion_failed', at: 5, terminatesRun: true }),
    ev({ id: 'second', kind: 'communication_lost', at: 5, terminatesRun: true }),
  ]);
  assert.equal(result.terminalEventId, 'first');
  assert.equal(result.category, 'assertion_failed');
});

test('不从文字猜身份：summary 含误导词汇仍按 kind 分类', () => {
  const byText = diagnose([
    ev({ id: 'x', kind: 'assertion_failed', at: 1, terminatesRun: true, summary: 'network timeout, connection reset' }),
  ]);
  assert.equal(byText.category, 'communication_interrupted' === byText.category ? 'impossible' : 'assertion_failed');

  const swappedText = diagnose([
    ev({ id: 'y', kind: 'communication_lost', at: 1, terminatesRun: true, summary: 'assertion failed: expected 1 got 2' }),
  ]);
  assert.equal(swappedText.category, 'communication_interrupted');

  const missing = diagnose([
    ev({ id: 'z', kind: 'prerequisite_missing', at: 1, terminatesRun: true, summary: 'assert failed after link down' }),
  ]);
  assert.equal(missing.category, 'prerequisite_missing');
});

test('完整因果链：传递原因按因果序排列，终止事件在末尾', () => {
  const result = diagnose([
    ev({ id: 'root', kind: 'run_started', at: 1 }),
    ev({ id: 'dep', kind: 'step_started', at: 2, causeIds: ['root'] }),
    ev({ id: 'env', kind: 'step_completed', at: 3, causeIds: ['root'] }),
    ev({ id: 'term', kind: 'prerequisite_missing', at: 4, terminatesRun: true, causeIds: ['dep', 'env'] }),
  ]);
  assert.deepEqual(
    result.causalChain.map((e) => e.id),
    ['root', 'dep', 'env', 'term'],
  );
  assert.deepEqual(result.missingCauseIds, []);
});

test('因果链：缺失的原因 id 被记录，循环引用安全', () => {
  const result = diagnose([
    ev({ id: 'a', kind: 'step_started', at: 1, causeIds: ['b'] }),
    ev({ id: 'b', kind: 'step_started', at: 2, causeIds: ['a', 'ghost'] }),
    ev({ id: 'term', kind: 'assertion_failed', at: 3, terminatesRun: true, causeIds: ['b'] }),
  ]);
  assert.equal(result.category, 'assertion_failed');
  assert.deepEqual(result.missingCauseIds, ['ghost']);
  assert.deepEqual(
    result.causalChain.map((e) => e.id),
    ['a', 'b', 'term'],
  );
});
