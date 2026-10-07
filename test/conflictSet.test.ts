import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import {
  mergeSets,
  normalizeSet,
  sortedIds,
  visibleState,
  type VersionedValue,
} from "../src/versionedValue";

const val = (value: number, vv: Record<string, number>): VersionedValue => ({
  value,
  vv,
  tombstone: false,
});

const del = (vv: Record<string, number>): VersionedValue => ({
  value: null,
  vv,
  tombstone: true,
});

test("并发版本同时保留在冲突集合, 不以时钟覆盖", () => {
  const set = normalizeSet([val(99, { R0: 2 }), val(20, { R1: 1 })]);
  equal(set.length, 2);
  deepEqual(visibleState(set), { kind: "conflict", values: [20, 99] });
});

test("被支配的旧版本被裁剪", () => {
  const set = normalizeSet([val(1, { R0: 1 }), val(2, { R0: 2 })]);
  equal(set.length, 1);
  deepEqual(visibleState(set), { kind: "value", value: 2 });
});

test("墓碑支配被撤回的版本, 合并后旧值不复活", () => {
  const tombstone = del({ R0: 2 });
  const stale = val(7, { R0: 1 });
  const merged = mergeSets([tombstone], [stale]);
  equal(merged.length, 1);
  equal(merged[0].tombstone, true);
  deepEqual(visibleState(merged), { kind: "deleted" });
});

test("更新的写支配墓碑后, 值重新可见", () => {
  const tombstone = del({ R0: 2 });
  const rewrite = val(9, { R0: 2, R1: 1 });
  const merged = mergeSets([tombstone], [rewrite]);
  deepEqual(visibleState(merged), { kind: "value", value: 9 });
});

test("mergeSets 满足交换律与幂等律", () => {
  const a = [val(1, { R0: 1 }), val(2, { R1: 1 })];
  const b = [del({ R0: 2 }), val(3, { R2: 4 })];
  deepEqual(sortedIds(mergeSets(a, b)), sortedIds(mergeSets(b, a)));
  deepEqual(sortedIds(mergeSets(a, a)), sortedIds(a));
  deepEqual(
    sortedIds(mergeSets(mergeSets(a, b), b)),
    sortedIds(mergeSets(a, b)),
  );
});
