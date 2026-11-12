import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchRejectedError } from '../src/errors.js';
import { replayDownload } from '../src/replay.js';
import type { DownloadEvent } from '../src/types.js';
import { EventFactory } from './helpers.js';

function replay(events: readonly DownloadEvent[]) {
  const downloadId = events[0]?.downloadId ?? 'd';
  return replayDownload(downloadId, events);
}

test('begin 缺失时片段保持未开始，不产生归档', () => {
  const factory = new EventFactory();
  const output = replay([
    factory.progress('d', 10, null),
    factory.progress('d', 20, 100),
  ]);
  assert.equal(output.begun, false);
  assert.equal(output.archive, null);
});

test('非 begin 事件序号早于 begin 时拒绝', () => {
  const factory = new EventFactory();
  const progress = factory.progress('d', 5, null);
  const begin = factory.begin('d', 'https://x/a');
  assert.throws(
    () => replay([begin, progress]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'BEGIN_NOT_FIRST',
  );
});

test('begin 唯一：重复 begin 拒绝', () => {
  const factory = new EventFactory();
  const begin = factory.begin('d', 'https://x/a');
  const beginAgain = factory.begin('d', 'https://x/a', 'begin-again');
  assert.throws(
    () => replay([begin, beginAgain]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'DUPLICATE_BEGIN',
  );
});

test('progress received 非降，total 未知变已知后固定', () => {
  const factory = new EventFactory();
  const output = replay([
    factory.begin('d', 'https://x/a'),
    factory.progress('d', 10, null),
    factory.progress('d', 40, 100),
    factory.progress('d', 40, null),
    factory.progress('d', 100, 100),
  ]);
  assert.equal(output.received, 100);
  assert.equal(output.total, 100);
});

test('progress received 回退拒绝', () => {
  const factory = new EventFactory();
  assert.throws(
    () =>
      replay([
        factory.begin('d', 'https://x/a'),
        factory.progress('d', 50, 100),
        factory.progress('d', 40, 100),
      ]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'RECEIVED_DECREASED',
  );
});

test('total 已知后改变拒绝', () => {
  const factory = new EventFactory();
  assert.throws(
    () =>
      replay([
        factory.begin('d', 'https://x/a'),
        factory.progress('d', 10, 100),
        factory.progress('d', 10, 200),
      ]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'TOTAL_CHANGED',
  );
});

test('received 超过 total 拒绝（携带 total 与未携带两种形态）', () => {
  const factory = new EventFactory();
  assert.throws(
    () =>
      replay([
        factory.begin('d', 'https://x/a'),
        factory.progress('d', 101, 100),
      ]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'RECEIVED_EXCEEDS_TOTAL',
  );

  const factory2 = new EventFactory();
  assert.throws(
    () =>
      replay([
        factory2.begin('d', 'https://x/a'),
        factory2.progress('d', 50, 100),
        factory2.progress('d', 101, null),
      ]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'RECEIVED_EXCEEDS_TOTAL',
  );
});

test('首个终态之后的事件忽略', () => {
  const factory = new EventFactory();
  const output = replay([
    factory.begin('d', 'https://x/a'),
    factory.progress('d', 100, 100),
    factory.complete('d', 'done'),
    // 即使回退也必须被忽略，不触发 RECEIVED_DECREASED。
    factory.progress('d', 0, 100, 'late-progress'),
    factory.cancel('d', 'late-cancel'),
  ]);
  assert.equal(output.terminal?.kind, 'complete');
  assert.equal(output.terminalReady, true);
  assert.equal(output.archive?.summary, 'done');
  assert.equal(output.received, 100);
});

test('complete 在 received 未达 total 时不就绪，保留等待更早 progress', () => {
  const factory = new EventFactory();
  const waiting = replay([
    factory.begin('d', 'https://x/a'),
    factory.progress('d', 60, 100),
    factory.complete('d', 'done'),
  ]);
  assert.equal(waiting.terminal?.kind, 'complete');
  assert.equal(waiting.terminalReady, false);
  assert.equal(waiting.archive, null);

  const factory2 = new EventFactory();
  const unknownTotal = replay([
    factory2.begin('d', 'https://x/a'),
    factory2.progress('d', 60, null),
    factory2.complete('d', 'done'),
  ]);
  assert.equal(unknownTotal.terminalReady, false);
});

test('cancel 立即就绪，不依赖 progress 与 total', () => {
  const factory = new EventFactory();
  const output = replay([
    factory.begin('d', 'https://x/a'),
    factory.cancel('d'),
  ]);
  assert.equal(output.terminalReady, true);
  assert.equal(output.archive?.kind, 'cancel');
  assert.equal(output.archive?.summary, null);
  assert.equal(output.archive?.total, null);
});

test('complete 在 total 为 0 且 received 为 0 时就绪', () => {
  const factory = new EventFactory();
  const output = replay([
    factory.begin('d', 'https://x/empty'),
    factory.complete('d', 'empty body'),
  ]);
  assert.equal(output.total, null);
  assert.equal(output.terminalReady, false);

  const factory2 = new EventFactory();
  const withZero = replay([
    factory2.begin('d', 'https://x/empty'),
    factory2.progress('d', 0, 0),
    factory2.complete('d', 'empty body'),
  ]);
  assert.equal(withZero.terminalReady, true);
  assert.equal(withZero.archive?.received, 0);
  assert.equal(withZero.archive?.total, 0);
});
