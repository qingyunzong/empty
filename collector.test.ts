import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VirtualListCollector, type VisibleEntry } from './collector.js';

const ITEM_HEIGHT = 40;

/** 模拟固定行高的虚拟列表：给定滚动偏移，返回可见条目与滚动范围。 */
class FakeVirtualList {
  constructor(
    public keys: string[],
    public viewportSize: number,
  ) {}

  get totalSize(): number {
    return this.keys.length * ITEM_HEIGHT;
  }

  visibleAt(offset: number): { entries: VisibleEntry<string>[]; range: { offset: number; viewportSize: number; totalSize: number } } {
    const clamped = Math.max(0, Math.min(offset, Math.max(0, this.totalSize - this.viewportSize)));
    const first = Math.floor(clamped / ITEM_HEIGHT);
    const count = Math.ceil(this.viewportSize / ITEM_HEIGHT);
    const entries: VisibleEntry<string>[] = [];
    for (let i = first; i < Math.min(this.keys.length, first + count); i += 1) {
      entries.push({ key: this.keys[i], index: i, offset: i * ITEM_HEIGHT });
    }
    return { entries, range: { offset: clamped, viewportSize: this.viewportSize, totalSize: this.totalSize } };
  }
}

function makeKeys(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `row-${i}`);
}

describe('VirtualListCollector', () => {
  it('遍历整个列表并按稳定业务键去重', () => {
    const list = new FakeVirtualList(makeKeys(100), 100);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 200 } });

    let target = collector.nextTarget();
    while (target !== null) {
      const { entries, range } = list.visibleAt(target);
      collector.ingest(entries, range);
      target = collector.nextTarget();
    }

    const status = collector.status();
    assert.equal(status.done, true);
    assert.equal(status.reason, 'exhausted');
    assert.equal(collector.keys().length, 100);
    assert.deepEqual(collector.keys(), makeKeys(100));
    // 已覆盖区间保存为单个完整区间。
    assert.deepEqual(status.coverage, [[0, list.totalSize]]);
  });

  it('总高度未知时依靠连续无新键证明结束', () => {
    const list = new FakeVirtualList(makeKeys(30), 100);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 200 }, loopThreshold: 3 });

    let target = collector.nextTarget();
    while (target !== null) {
      const { entries, range } = list.visibleAt(target);
      collector.ingest(entries, { offset: range.offset, viewportSize: range.viewportSize });
      target = collector.nextTarget();
    }

    const status = collector.status();
    assert.equal(status.done, true);
    assert.equal(status.reason, 'exhausted');
    assert.equal(collector.keys().length, 30);
  });

  it('检测滚动循环：重复可见签名且无新键', () => {
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 50 }, loopThreshold: 5 });
    const frame: VisibleEntry<string>[] = [
      { key: 'a', index: 0, offset: 0 },
      { key: 'b', index: 1, offset: 40 },
    ];
    collector.ingest(frame, { offset: 0, viewportSize: 80 });
    let loops = 0;
    for (let i = 0; i < 5; i += 1) {
      const report = collector.ingest(frame, { offset: 0, viewportSize: 80 });
      if (report.loopDetected) loops += 1;
    }
    assert.ok(loops >= 1);
    assert.equal(collector.status().loops, loops);
    assert.equal(collector.status().reason, 'exhausted');
  });

  it('检测动态插入并重新覆盖受影响区间', () => {
    const keys = makeKeys(50);
    const list = new FakeVirtualList(keys, 100);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 500 } });

    // 先扫一遍前半部分。
    for (let i = 0; i < 3; i += 1) {
      const target = collector.nextTarget();
      assert.notEqual(target, null);
      const { entries, range } = list.visibleAt(target!);
      collector.ingest(entries, range);
    }
    const beforeKeys = collector.keys().length;

    // 在已扫过的位置动态插入 5 行。
    keys.splice(2, 0, 'injected-0', 'injected-1', 'injected-2', 'injected-3', 'injected-4');
    const { entries, range } = list.visibleAt(0);
    const report = collector.ingest(entries, range);

    assert.ok(report.insertions > 0);
    assert.ok(collector.status().insertions > 0);
    assert.equal(collector.keys().length, beforeKeys + report.newKeys);

    // 继续跑完，插入的键全部收集到，且最终完整覆盖新总高度。
    let target = collector.nextTarget();
    while (target !== null) {
      const frame = list.visibleAt(target);
      collector.ingest(frame.entries, frame.range);
      target = collector.nextTarget();
    }
    const status = collector.status();
    assert.equal(status.reason, 'exhausted');
    assert.equal(collector.keys().length, 55);
    assert.deepEqual(status.coverage, [[0, list.totalSize]]);
  });

  it('容器高度变化后重新规划并继续直到完整覆盖', () => {
    const list = new FakeVirtualList(makeKeys(80), 100);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 500 } });

    // 用小视口扫几步。
    for (let i = 0; i < 2; i += 1) {
      const target = collector.nextTarget();
      const { entries, range } = list.visibleAt(target!);
      collector.ingest(entries, range);
    }

    // 容器变高：视口从 100 变为 400。
    list.viewportSize = 400;
    collector.onLayout({ containerHeight: 400, totalSize: list.totalSize });

    let target = collector.nextTarget();
    while (target !== null) {
      const { entries, range } = list.visibleAt(target);
      collector.ingest(entries, range);
      target = collector.nextTarget();
    }

    const status = collector.status();
    assert.equal(status.reason, 'exhausted');
    assert.equal(collector.keys().length, 80);
    assert.deepEqual(status.coverage, [[0, list.totalSize]]);
  });

  it('容器变高使已判定结束的采集重新打开', () => {
    // 总高度未知、视口大于内容：一帧即证明无新键。
    const list = new FakeVirtualList(makeKeys(10), 2000);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 500 }, loopThreshold: 1 });

    const target = collector.nextTarget();
    const frame = list.visibleAt(target!);
    // 视口大于全部内容且总高度已知：一帧即完整覆盖，证明无新键。
    collector.ingest(frame.entries, frame.range);
    assert.equal(collector.status().done, true);

    // 内容变多、容器变小：覆盖不再完整，应重新打开。
    list.keys = makeKeys(500);
    list.viewportSize = 100;
    collector.onLayout({ containerHeight: 100, totalSize: list.totalSize });
    assert.equal(collector.status().done, false);

    let t = collector.nextTarget();
    while (t !== null) {
      const f = list.visibleAt(t);
      collector.ingest(f.entries, f.range);
      t = collector.nextTarget();
    }
    assert.equal(collector.keys().length, 500);
  });

  it('达到公开步数预算时以 budget 结束', () => {
    const list = new FakeVirtualList(makeKeys(100), 100);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 3 } });

    let target = collector.nextTarget();
    while (target !== null) {
      const { entries, range } = list.visibleAt(target);
      collector.ingest(entries, range);
      target = collector.nextTarget();
    }

    const status = collector.status();
    assert.equal(status.done, true);
    assert.equal(status.reason, 'budget');
    assert.equal(status.stepsUsed, 3);
    assert.ok(collector.keys().length < 100);
    assert.ok(collector.keys().length > 0);
  });

  it('达到公开键数预算时以 budget 结束', () => {
    const list = new FakeVirtualList(makeKeys(100), 100);
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 500, maxKeys: 10 } });

    let target = collector.nextTarget();
    while (target !== null) {
      const { entries, range } = list.visibleAt(target);
      collector.ingest(entries, range);
      target = collector.nextTarget();
    }

    const status = collector.status();
    assert.equal(status.reason, 'budget');
    assert.ok(collector.keys().length >= 10);
  });

  it('结束后拒绝继续 ingest', () => {
    const collector = new VirtualListCollector<string>({ budget: { maxSteps: 0 } });
    assert.equal(collector.nextTarget(), null);
    assert.equal(collector.status().reason, 'budget');
    const report = collector.ingest([{ key: 'x' }], { offset: 0, viewportSize: 100 });
    assert.equal(report.accepted, false);
  });
});
