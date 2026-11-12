import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BatchRejectedError } from '../src/errors.js';
import { DownloadStateStore } from '../src/store.js';
import { EventFactory } from './helpers.js';

function assertRejected(
  callback: () => unknown,
  code: string,
): void {
  assert.throws(
    callback,
    (error: unknown) => error instanceof BatchRejectedError && error.code === code,
  );
}

test('非法 progress 整批回滚：已暂存事件与归档全部保持批次前状态', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();

  const goodBegin = factory.begin('a', 'https://x/a');
  const goodProgress = factory.progress('a', 10, 100);
  store.ingest([goodBegin, goodProgress]);
  const archivesBefore = store.listArchives();

  const otherBegin = factory.begin('b', 'https://x/b');
  const badProgress = factory.progress('b', 50, 40); // received > total
  assertRejected(
    () => store.ingest([otherBegin, badProgress]),
    'RECEIVED_EXCEEDS_TOTAL',
  );

  // 回滚后：b 完全不存在，a 的视图与事件数不变。
  assert.equal(store.getDownload('b'), null);
  assert.deepEqual(store.listArchives(), archivesBefore);
  const viewA = store.getDownload('a')!;
  assert.equal(viewA.received, 10);
  assert.equal(viewA.total, 100);

  // 回滚的事件可在修正后重新提交（seq 已被释放）。
  const fixed = factory.progress('b', 40, 40, 'prog-b-fixed');
  const complete = factory.complete('b', 'done-b');
  const retry = store.ingest([otherBegin, fixed, complete]);
  assert.equal(retry.accepted, 3);
  assert.equal(store.listArchives().length, 1);
  assert.equal(store.listArchives()[0]!.downloadId, 'b');
});

test('乱序批次中 begin 未唯一（begin 排序靠后导致非 begin 更早）整批回滚', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();
  const progress = factory.progress('c', 5, null);
  const begin = factory.begin('c', 'https://x/c');
  assertRejected(() => store.ingest([progress, begin]), 'BEGIN_NOT_FIRST');
  assert.equal(store.getDownload('c'), null);
});

test('相同事件重投忽略：跨批次与同批次均幂等', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();
  const begin = factory.begin('d', 'https://x/d');
  const progress = factory.progress('d', 10, null);

  const first = store.ingest([begin, progress]);
  assert.equal(first.accepted, 2);

  const redelivered = store.ingest([begin, progress]);
  assert.equal(redelivered.accepted, 0);
  assert.equal(redelivered.ignoredDuplicates.length, 2);
  assert.deepEqual(redelivered.deltas, []);

  const withinBatch = store.ingest([begin, begin, progress]);
  assert.equal(withinBatch.accepted, 0);
  assert.equal(withinBatch.ignoredDuplicates.length, 3);
});

test('同 eventId 不同载荷为冲突，整批回滚', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();
  const begin = factory.begin('e', 'https://x/e');
  store.ingest([begin]);

  const conflicting = { ...begin, seq: 900, url: 'https://x/tampered' };
  assertRejected(() => store.ingest([conflicting]), 'CONFLICT_EVENT_ID');
  assert.equal(store.getDownload('e')!.url, 'https://x/e');
});

test('全局序号冲突整批回滚，且先写入的同批事件一并撤销', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();
  const first = factory.begin('f', 'https://x/f');
  store.ingest([first]);

  const factory2 = new EventFactory();
  const colliding = factory2.begin('g', 'https://x/g'); // seq 0 与 first 冲突
  const extra = factory2.progress('g', 1, null);
  assertRejected(() => store.ingest([extra, colliding]), 'CONFLICT_SEQ');
  assert.equal(store.getDownload('g'), null);
});

test('畸形事件拒绝回滚', () => {
  const store = new DownloadStateStore();
  assertRejected(
    () =>
      store.ingest([
        {
          kind: 'progress',
          eventId: 'bad',
          seq: 1,
          downloadId: 'h',
          received: -3,
          total: null,
        },
      ]),
    'MALFORMED_EVENT',
  );
  assert.equal(store.getDownload('h'), null);
});

test('导出/导入状态包：归档与后续乱序处理完全恢复', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();
  store.ingest([
    factory.begin('i', 'https://x/i'),
    factory.progress('i', 50, 100),
  ]);
  store.ingest([factory.progress('i', 100, 100), factory.complete('i', 'fin')]);

  const snapshot = store.exportSnapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.events.length, 4);

  const restored = DownloadStateStore.importSnapshot(snapshot);
  assert.deepEqual(restored.listArchives(), store.listArchives());

  // 恢复后仍能识别重投并处理新下载。
  const redeliver = restored.ingest([snapshot.events[0]!]);
  assert.equal(redeliver.accepted, 0);
  assert.equal(redeliver.ignoredDuplicates.length, 1);

  const factory2 = new EventFactory(1000);
  const next = restored.ingest([
    factory2.begin('j', 'https://x/j'),
    factory2.cancel('j'),
  ]);
  assert.equal(next.deltas[0]!.added?.kind, 'cancel');
  assert.equal(restored.listArchives().length, 2);
});
