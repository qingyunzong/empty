import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchRejectedError } from '../src/errors.js';
import { DownloadStateStore } from '../src/store.js';
import { EventFactory } from './helpers.js';

test('反向撤销：序号更早的 complete 就绪后撤销已归档 cancel', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(10);

  // 序号：begin=10, full=11, cancel=12, complete=13；cancel 是首个终态。
  const begin = factory.begin('r1', 'https://x/r1', undefined, 10);
  const full = factory.progress('r1', 80, 80, undefined, 11);
  const cancel = factory.cancel('r1', undefined, 12);
  const complete = factory.complete('r1', 'fin', undefined, 13);

  // 先到 begin + cancel：cancel 立即就绪并归档。
  store.ingest([begin, cancel]);
  assert.equal(store.listArchives()[0]!.kind, 'cancel');

  // complete(13) 在首个终态 cancel(12) 之后，重放完全忽略，净差为空。
  assert.deepEqual(store.ingest([complete]).deltas, []);

  // full(11) 序号早于首个终态，重放时被吸收：终态仍是 cancel，
  // 但归档的 received/total 被更新（同终态的内容净差）。
  const progressDelta = store.ingest([full]);
  assert.equal(progressDelta.deltas[0]!.removed?.kind, 'cancel');
  assert.equal(progressDelta.deltas[0]!.added?.kind, 'cancel');
  assert.equal(progressDelta.deltas[0]!.added?.received, 80);
  assert.equal(store.listArchives()[0]!.kind, 'cancel');
  assert.equal(store.listArchives()[0]!.terminalSeq, 12);
  assert.equal(store.getDownload('r1')!.stage, 'cancel');
  assert.equal(store.getDownload('r1')!.terminalReady, true);

  // 构造真正更早的 complete：另一下载中 complete 序号小于 cancel。
  const store2 = new DownloadStateStore();
  const factory2 = new EventFactory(20);
  const begin2 = factory2.begin('r2', 'https://x/r2', undefined, 20);
  const full2 = factory2.progress('r2', 80, 80, undefined, 21);
  const complete2 = factory2.complete('r2', 'fin', undefined, 22);
  const cancel2 = factory2.cancel('r2', undefined, 23);

  // cancel 序号更大、先到达；但 begin 已在，重放后它是首个终态并立即归档。
  store2.ingest([begin2, cancel2]);
  assert.equal(store2.listArchives()[0]!.kind, 'cancel');

  // 更早终态 complete(22) 到达：取代 cancel(23)，但 progress(21) 还没到，未就绪。
  const waiting = store2.ingest([complete2]);
  assert.equal(waiting.deltas[0]!.removed?.kind, 'cancel');
  assert.equal(waiting.deltas[0]!.added, null);
  assert.equal(store2.listArchives().length, 0);
  assert.equal(store2.getDownload('r2')!.terminalReady, false);
  assert.equal(store2.getDownload('r2')!.stage, 'complete');

  // 迟到的 progress(21) 序号早于首个终态 complete(22)，吸收后 complete 就绪。
  const resolved = store2.ingest([full2]);
  assert.equal(resolved.deltas[0]!.removed, null);
  assert.equal(resolved.deltas[0]!.added?.kind, 'complete');
  assert.equal(store2.listArchives()[0]!.summary, 'fin');
  assert.equal(store2.listArchives().length, 1);
});

test('多下载混合批次：仅受影响下载重放，净差按下载隔离', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();

  store.ingest([
    factory.begin('m1', 'https://x/m1'),
    factory.progress('m1', 100, 100),
    factory.complete('m1', 'm1-done'),
  ]);
  const m1Archive = store.listArchives()[0]!;

  const result = store.ingest([
    factory.begin('m2', 'https://x/m2'),
    factory.cancel('m2'),
  ]);
  assert.deepEqual(result.affectedDownloads, ['m2']);
  assert.equal(result.deltas.length, 1);
  assert.equal(result.deltas[0]!.downloadId, 'm2');

  // m1 未受影响，归档引用保持稳定。
  assert.equal(store.listArchives().length, 2);
  assert.deepEqual(store.getDownload('m1')!.archive, m1Archive);
});

test('暂存桶中的非法 progress 仍在落桶后重放时触发整批回滚', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();

  // 只有 progress、没有 begin：先合法暂存。
  store.ingest([factory.progress('s1', 30, 100, undefined, 5)]);
  assert.equal(store.getDownload('s1')!.stage, 'staged');

  // 暂存桶内出现回退 progress，重放即拒绝，新事件整批回滚，旧暂存保留。
  assert.throws(
    () => store.ingest([factory.progress('s1', 10, 100, undefined, 6)]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'RECEIVED_DECREASED',
  );
  const view = store.getDownload('s1')!;
  assert.equal(view.stage, 'staged');
  assert.equal(view.received, 30);
});

test('空批次与重复重投不产生净差', () => {
  const store = new DownloadStateStore();
  const empty = store.ingest([]);
  assert.equal(empty.accepted, 0);
  assert.deepEqual(empty.deltas, []);
  assert.deepEqual(empty.affectedDownloads, []);
});
