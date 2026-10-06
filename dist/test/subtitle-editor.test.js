import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubtitleEditor } from "../src/subtitle-editor.js";
describe("插入与半开区间", () => {
    it("空编辑器没有可见段", () => {
        const ed = new SubtitleEditor();
        assert.deepEqual(ed.visibleSegments(), []);
        assert.equal(ed.visibleAt(0), null);
        assert.equal(ed.version, 0);
    });
    it("半开区间：end 点不可见，相邻区间首尾相接", () => {
        const ed = new SubtitleEditor();
        const a = ed.insert({ layer: 0, start: 0, end: 10, text: "a" });
        const b = ed.insert({ layer: 0, start: 10, end: 20, text: "b" });
        assert.equal(ed.visibleAt(9)?.id, a);
        assert.equal(ed.visibleAt(10)?.id, b);
        assert.equal(ed.visibleAt(20), null);
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [
            [0, 10, a],
            [10, 20, b],
        ]);
    });
    it("拒绝非法区间", () => {
        const ed = new SubtitleEditor();
        assert.throws(() => ed.insert({ layer: 0, start: 10, end: 10 }));
        assert.throws(() => ed.insert({ layer: 0, start: 20, end: 10 }));
        assert.throws(() => ed.insert({ layer: 0, start: -1, end: 10 }));
        assert.throws(() => ed.insert({ layer: 0, start: 0.5, end: 10 }));
        assert.throws(() => ed.insert({ layer: 1.5, start: 0, end: 10 }));
        assert.equal(ed.version, 0, "非法插入不应改变版本");
    });
});
describe("遮挡规则", () => {
    it("高层遮挡低层，未交叠部分仍可见", () => {
        const ed = new SubtitleEditor();
        const low = ed.insert({ layer: 0, start: 0, end: 100, text: "low" });
        const high = ed.insert({ layer: 1, start: 40, end: 60, text: "high" });
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [
            [0, 40, low],
            [40, 60, high],
            [60, 100, low],
        ]);
    });
    it("同层时后插入优先", () => {
        const ed = new SubtitleEditor();
        const first = ed.insert({ layer: 0, start: 0, end: 100, text: "first" });
        const second = ed.insert({ layer: 0, start: 30, end: 70, text: "second" });
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [
            [0, 30, first],
            [30, 70, second],
            [70, 100, first],
        ]);
    });
    it("层优先于插入顺序：低层后插入仍被高层先插入遮挡", () => {
        const ed = new SubtitleEditor();
        const high = ed.insert({ layer: 5, start: 0, end: 100, text: "high" });
        ed.insert({ layer: 0, start: 10, end: 50, text: "low" });
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [[0, 100, high]]);
    });
    it("同源基本区间合并为最大连续段", () => {
        const ed = new SubtitleEditor();
        const base = ed.insert({ layer: 1, start: 0, end: 100, text: "base" });
        // 低层字幕在 base 之下，不改变可见性，但其边界不应把 base 的可见段打断。
        ed.insert({ layer: 0, start: 40, end: 60, text: "under" });
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [[0, 100, base]]);
    });
});
describe("裁剪", () => {
    it("裁剪取交集，两端收缩", () => {
        const ed = new SubtitleEditor();
        const id = ed.insert({ layer: 0, start: 0, end: 100, text: "x" });
        assert.equal(ed.crop(id, 20, 80), true);
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [[20, 80, id]]);
    });
    it("裁剪窗口无交叠时字幕被移除", () => {
        const ed = new SubtitleEditor();
        const id = ed.insert({ layer: 0, start: 0, end: 50 });
        assert.equal(ed.crop(id, 100, 200), true);
        assert.equal(ed.get(id), undefined);
        assert.deepEqual(ed.visibleSegments(), []);
    });
    it("裁剪后可见性按新区间重新计算", () => {
        const ed = new SubtitleEditor();
        const low = ed.insert({ layer: 0, start: 0, end: 100, text: "low" });
        const high = ed.insert({ layer: 1, start: 0, end: 100, text: "high" });
        ed.crop(high, 0, 30);
        assert.deepEqual(ed.visibleSegments().map((s) => [s.start, s.end, s.source]), [
            [0, 30, high],
            [30, 100, low],
        ]);
    });
    it("裁剪不存在的 id 返回 false 且不进历史", () => {
        const ed = new SubtitleEditor();
        assert.equal(ed.crop(999, 0, 10), false);
        assert.equal(ed.version, 0);
        assert.equal(ed.canUndo, false);
    });
});
describe("撤销", () => {
    it("撤销插入：恢复到插入前的同一版本与状态", () => {
        const ed = new SubtitleEditor();
        const before = { version: ed.version, list: ed.list(), segments: ed.visibleSegments() };
        ed.insert({ layer: 0, start: 0, end: 50, text: "x" });
        assert.equal(ed.version, before.version + 1);
        assert.equal(ed.undo(), true);
        assert.equal(ed.version, before.version);
        assert.deepEqual(ed.list(), before.list);
        assert.deepEqual(ed.visibleSegments(), before.segments);
    });
    it("撤销裁剪：恢复原区间", () => {
        const ed = new SubtitleEditor();
        const id = ed.insert({ layer: 0, start: 0, end: 100, text: "x" });
        ed.crop(id, 10, 20);
        assert.deepEqual(ed.get(id), { id, layer: 0, start: 10, end: 20, text: "x", seq: 0 });
        ed.undo();
        assert.deepEqual(ed.get(id), { id, layer: 0, start: 0, end: 100, text: "x", seq: 0 });
    });
    it("连续撤销按逆序恢复，空栈撤销返回 false", () => {
        const ed = new SubtitleEditor();
        ed.insert({ layer: 0, start: 0, end: 10 });
        ed.insert({ layer: 0, start: 20, end: 30 });
        assert.equal(ed.version, 2);
        assert.equal(ed.undo(), true);
        assert.equal(ed.version, 1);
        assert.equal(ed.list().length, 1);
        assert.equal(ed.undo(), true);
        assert.equal(ed.version, 0);
        assert.equal(ed.list().length, 0);
        assert.equal(ed.undo(), false);
    });
    it("撤销是完整版本回滚：状态与插入前完全一致", () => {
        const ed = new SubtitleEditor();
        ed.insert({ layer: 0, start: 0, end: 10, text: "a" });
        ed.undo();
        assert.equal(ed.version, 0);
        assert.deepEqual(ed.list(), []);
        // 回滚后重新插入，等同于在“插入前那一版”上重新操作
        const id = ed.insert({ layer: 0, start: 5, end: 15, text: "b" });
        assert.deepEqual(ed.get(id), { id, layer: 0, start: 5, end: 15, text: "b", seq: 0 });
    });
});
