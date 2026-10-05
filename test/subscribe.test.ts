import { test } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityMonitor, Correction, Segment } from "../src/monitor.js";

function key(s: Segment): string {
  return `${s.start}|${s.end}|${s.services.join(",")}`;
}

/** 用净差更正维护的镜像状态：added 加入、removed 移除。 */
class Mirror {
  segments = new Map<string, Segment>();
  versions: number[] = [];
  apply(c: Correction): void {
    for (const s of c.removed) {
      assert.ok(this.segments.delete(key(s)), `removed 段必须存在: ${key(s)}`);
    }
    for (const s of c.added) {
      assert.ok(!this.segments.has(key(s)), `added 段不得重复: ${key(s)}`);
      this.segments.set(key(s), s);
    }
    this.versions.push(c.version);
  }
  sorted(): Segment[] {
    return [...this.segments.values()].sort((a, b) => a.start - b.start);
  }
}

test("订阅净差：镜像状态始终与重算一致，版本单调且与监控器同版", () => {
  const m = new AvailabilityMonitor();
  const mirror = new Mirror();
  m.subscribe(2, (c) => {
    // 更正绑定的版本号必须等于投递时监控器的当前版本
    assert.equal(c.version, m.version);
    mirror.apply(c);
  });

  m.addInterval("a", 0, 10);
  m.addInterval("b", 2, 8);
  m.addInterval("c", 4, 6);
  m.removeInterval("b", 3, 5);
  m.addDependency("c", "a");
  m.removeDependency("c", "a");
  m.addInterval("b", 20, 30);

  assert.deepEqual(mirror.sorted(), m.compute(2));
  // 更正版本严格递增，且不超过当前版本（无净差的提交不发更正）
  for (let i = 1; i < mirror.versions.length; i++) {
    assert.ok(mirror.versions[i]! > mirror.versions[i - 1]!);
  }
  assert.ok((mirror.versions[mirror.versions.length - 1] ?? 0) <= m.version);
  // 净差语义：removed 与 added 不得包含相同段
  const mirror2 = new Mirror();
  m.subscribe(1, (c) => mirror2.apply(c));
  m.removeInterval("a", 0, 10);
  assert.deepEqual(mirror2.sorted(), m.compute(1));
});

test("视图无变化时不发更正；加删抵消后镜像仍一致", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 10);
  let calls = 0;
  m.subscribe(1, () => calls++);
  calls = 0;
  // 不影响任何视图的无效变更：版本推进，但不发更正。
  const v0 = m.version;
  m.removeInterval("ghost", 0, 5);
  m.removeDependency("a", "nonexistent");
  assert.equal(calls, 0, "视图无净变化不应收到更正");
  assert.equal(m.version, v0 + 2, "版本仍随变更推进");
  // 加上又删掉同一区间：两次更正净效果抵消，镜像与重算一致。
  const seen: Correction[] = [];
  m.subscribe(2, (c) => seen.push(c));
  m.addInterval("b", 2, 4);
  m.removeInterval("b", 2, 4);
  const mirror = new Mirror();
  for (const c of seen) mirror.apply(c);
  assert.deepEqual(mirror.sorted(), m.compute(2));
});

test("初始订阅收到当前快照作为全量 added", () => {
  const m = new AvailabilityMonitor();
  m.addInterval("a", 0, 5);
  m.addInterval("b", 1, 4);
  const got: Correction[] = [];
  m.subscribe(2, (c) => got.push(c));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0]!.added, [{ start: 1, end: 4, services: ["a", "b"] }]);
  assert.deepEqual(got[0]!.removed, []);
  assert.equal(got[0]!.version, m.version);
});
