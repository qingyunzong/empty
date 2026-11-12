import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DownloadStateStore } from '../src/store.js';
import type { DownloadEvent } from '../src/types.js';
import { EventFactory, seededRandom, shuffled } from './helpers.js';

/** 构造一个完整下载的有序事件集。 */
function completeLifecycle(factory: EventFactory, downloadId: string): DownloadEvent[] {
  return [
    factory.begin(downloadId, `https://x/${downloadId}`),
    factory.progress(downloadId, 30, 100),
    factory.progress(downloadId, 70, 100),
    factory.progress(downloadId, 100, 100),
    factory.complete(downloadId, `summary-${downloadId}`),
  ];
}

test('乱序到达：begin 未到的片段暂存，begin 到达后一次性重放归档', () => {
  const factory = new EventFactory();
  const events = completeLifecycle(factory, 'd1');
  const begin = events[0]!;
  const fragments = events.slice(1);

  const store = new DownloadStateStore();
  const staged = store.ingest(fragments);
  assert.equal(staged.accepted, fragments.length);
  assert.deepEqual(staged.deltas, []);
  const view = store.getDownload('d1')!;
  assert.equal(view.stage, 'staged');
  assert.equal(view.begun, false);
  assert.equal(store.listArchives().length, 0);

  const begun = store.ingest([begin]);
  assert.equal(begun.deltas.length, 1);
  assert.equal(begun.deltas[0]!.removed, null);
  assert.equal(begun.deltas[0]!.added?.kind, 'complete');
  assert.equal(store.listArchives()[0]!.summary, 'summary-d1');
});

test('到达排列不变性：任意洗牌、任意分批得到相同归档', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = seededRandom(seed);
    const factory = new EventFactory();
    const events = completeLifecycle(factory, 'perm');
    const ordered = shuffled(events, random);

    // 在随机位置切成 2~3 个批次。
    const cutA = 1 + Math.floor(random() * (ordered.length - 1));
    const cutB = cutA + 1 + Math.floor(random() * Math.max(1, ordered.length - cutA - 1));
    const batches = [
      ordered.slice(0, cutA),
      ordered.slice(cutA, Math.min(cutB, ordered.length)),
      ordered.slice(Math.min(cutB, ordered.length)),
    ].filter((batch) => batch.length > 0);

    const store = new DownloadStateStore();
    for (const batch of batches) {
      store.ingest(batch);
    }

    const archives = store.listArchives();
    assert.equal(archives.length, 1, `seed ${seed}`);
    const archive = archives[0]!;
    assert.equal(archive.downloadId, 'perm');
    assert.equal(archive.kind, 'complete');
    assert.equal(archive.received, 100);
    assert.equal(archive.total, 100);
    assert.equal(archive.summary, 'summary-perm');

    const view = store.getDownload('perm')!;
    assert.equal(view.stage, 'complete');
    assert.equal(view.terminalReady, true);
  }
});

test('complete 先保留，迟到的更早 progress 补齐后就绪', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();

  // 序号顺序：begin(0), 50%(1), 100%(2), complete(3)；100% 那条延迟到达。
  const begin = factory.begin('d2', 'https://x/d2', undefined, 0);
  const half = factory.progress('d2', 50, 100, undefined, 1);
  const full = factory.progress('d2', 100, 100, undefined, 2);
  const complete = factory.complete('d2', 'done', undefined, 3);

  // 到达顺序：begin -> half -> complete（此时未就绪）-> full（迟到但序号早于终态）。
  store.ingest([begin, half]);
  const waiting = store.ingest([complete]);
  assert.deepEqual(waiting.deltas, []);
  assert.equal(store.getDownload('d2')!.terminalReady, false);
  assert.equal(store.listArchives().length, 0);

  const resolved = store.ingest([full]);
  assert.equal(resolved.deltas[0]!.added?.kind, 'complete');
  assert.equal(resolved.deltas[0]!.added?.received, 100);
});

test('迟到取消：序号更早的 cancel 撤销已归档 complete，输出删除+新增净差', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory();

  const begin = factory.begin('d3', 'https://x/d3');
  // 序号分配：begin=0, full=1, complete=2, cancel=3
  const full = factory.progress('d3', 100, 100);
  const complete = factory.complete('d3', 'done');
  const cancel = factory.cancel('d3');

  // 先到达 begin/full/complete 并完成归档。
  store.ingest([begin, full, complete]);
  const before = store.listArchives()[0]!;
  assert.equal(before.kind, 'complete');
  assert.equal(before.terminalSeq, complete.seq);

  // cancel 序号更大属于“首个终态之后”，重放时被忽略 → 归档不变。
  const ignoredLate = store.ingest([cancel]);
  assert.deepEqual(ignoredLate.deltas, []);
  assert.equal(store.listArchives()[0]!.kind, 'complete');

  // 构造真正“更早终态”场景：另一下载中 cancel 的序号小于 complete。
  const store2 = new DownloadStateStore();
  const factory2 = new EventFactory();
  const begin2 = factory2.begin('d4', 'https://x/d4');
  const cancel2 = factory2.cancel('d4'); // 序号 1
  const full2 = factory2.progress('d4', 100, 100);
  const complete2 = factory2.complete('d4', 'done'); // 序号 3

  // complete 先到且因缺 progress 未就绪；补 progress 后 complete 就绪归档。
  store2.ingest([begin2, complete2]);
  store2.ingest([full2]);
  assert.equal(store2.listArchives()[0]!.kind, 'complete');

  // 更早的 cancel 到达：重放后首个终态变为 cancel，撤销 complete 归档。
  const revoked = store2.ingest([cancel2]);
  assert.equal(revoked.deltas.length, 1);
  assert.equal(revoked.deltas[0]!.removed?.kind, 'complete');
  assert.equal(revoked.deltas[0]!.added?.kind, 'cancel');
  assert.equal(store2.listArchives()[0]!.kind, 'cancel');
  assert.equal(store2.getDownload('d4')!.stage, 'cancel');
});

test('首个终态之后到达的第二个终态被忽略而非报错', () => {
  const store = new DownloadStateStore();
  const factory = new EventFactory(100);
  const begin = factory.begin('d6', 'https://x/d6', undefined, 100);
  const cancel = factory.cancel('d6', undefined, 101);
  const secondCancel = factory.cancel('d6', 'cancel-d6-again', 102);
  const result = store.ingest([begin, cancel, secondCancel]);
  assert.equal(result.deltas[0]!.added?.kind, 'cancel');
  assert.equal(result.accepted, 3);
  // 第二个 cancel 位于首个终态之后被忽略，归档仍只有一个且指向首个 cancel。
  assert.equal(store.listArchives().length, 1);
  assert.equal(store.listArchives()[0]!.terminalSeq, 101);
});
