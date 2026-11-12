import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchRejectedError } from '../src/errors.js';
import { DownloadStateStore } from '../src/store.js';
import { EventFactory } from './helpers.js';

test('complete 之后到达、但序号更早的 progress 解除未就绪状态', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(30);
  const begin = factory.begin('e1', 'https://x/e1', undefined, 30);
  const full = factory.progress('e1', 50, 50, undefined, 31);
  const complete = factory.complete('e1', 'fin', undefined, 32);

  // complete 先到（progress 迟到）：total 未知，complete 未就绪，不归档。
  store.ingest([begin, complete]);
  assert.equal(store.listArchives().length, 0);

  // progress 序号 31 < complete 32，属于“更早 progress”，吸收后就绪。
  const result = store.ingest([full]);
  assert.equal(result.deltas[0]!.added?.kind, 'complete');
  assert.equal(result.deltas[0]!.added?.received, 50);
  assert.equal(store.listArchives()[0]!.total, 50);
});

test('无 begin 暂存桶内 progress 同样执行非降与超限校验', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(40);
  store.ingest([factory.progress('e2', 50, 100, undefined, 40)]);

  assert.throws(
    () => store.ingest([factory.progress('e2', 120, 100, undefined, 41)]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'RECEIVED_EXCEEDS_TOTAL',
  );
  // 回滚后暂存桶仍是第一条。
  assert.equal(store.getDownload('e2')!.received, 50);
});

test('total 从 null 变为已知后，后续 null total 不得改变它', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(50);
  store.ingest([
    factory.begin('e3', 'https://x/e3', undefined, 50),
    factory.progress('e3', 10, 100, undefined, 51),
    factory.progress('e3', 10, null, 'prog-e3-10-null', 52),
  ]);
  assert.equal(store.getDownload('e3')!.total, 100);
});

test('全局序号唯一性跨下载生效', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(60);
  store.ingest([factory.begin('e4', 'https://x/e4', undefined, 60)]);
  assert.throws(
    () =>
      store.ingest([
        { kind: 'begin', eventId: 'other', seq: 60, downloadId: 'e5', url: 'https://x/e5' },
      ]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'CONFLICT_SEQ',
  );
  assert.equal(store.getDownload('e5'), null);
});

test('同一批次内 eventId/seq 自相冲突也整批回滚', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(70);
  const first = factory.begin('e6', 'https://x/e6', undefined, 70);
  const duplicateId = { ...first, seq: 71, downloadId: 'e7' };
  assert.throws(
    () => store.ingest([first, duplicateId]),
    (error: unknown) => error instanceof BatchRejectedError &&
      error.code === 'CONFLICT_EVENT_ID',
  );
  assert.equal(store.getDownload('e6'), null);
  assert.equal(store.getDownload('e7'), null);
});
