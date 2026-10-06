import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubtitleEditor } from "../src/subtitle-editor.js";
import { RasterReference } from "./raster-reference.js";
/** mulberry32：确定性伪随机数发生器 */
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function serialize(ed) {
    return JSON.stringify({ version: ed.version, list: ed.list() });
}
const SEEDS = [1, 7, 42, 1337, 20261007];
const OPS_PER_SEED = 400;
const MAX_TIME = 600;
const MAX_LAYER = 3;
describe("随机操作 vs 逐毫秒栅格", () => {
    for (const seed of SEEDS) {
        it(`seed=${seed}：${OPS_PER_SEED} 次随机插入/裁剪/撤销后状态一致`, () => {
            const rng = makeRng(seed);
            const editor = new SubtitleEditor();
            const raster = new RasterReference();
            // 测试侧独立记录“每次变更前”的快照，验证撤销恢复到同一版本。
            const snapshots = [];
            // 当前存活的字幕 id（两侧一致，用于挑选裁剪目标）。
            let liveIds = [];
            for (let step = 0; step < OPS_PER_SEED; step++) {
                const roll = rng();
                if (roll < 0.55 || liveIds.length === 0) {
                    // 插入
                    const layer = Math.floor(rng() * (MAX_LAYER + 1));
                    const start = Math.floor(rng() * MAX_TIME);
                    const end = start + 1 + Math.floor(rng() * 250);
                    const text = `s${seed}-${step}`;
                    snapshots.push(serialize(editor));
                    const idA = editor.insert({ layer, start, end, text });
                    const idB = raster.insert(layer, start, end, text);
                    assert.equal(idA, idB, `step ${step}: id 不一致`);
                    liveIds.push(idA);
                }
                else if (roll < 0.85) {
                    // 裁剪：偶尔选一个已不存在的 id，验证空操作不进历史
                    const pickMissing = rng() < 0.1;
                    const id = pickMissing
                        ? 1_000_000 + step
                        : liveIds[Math.floor(rng() * liveIds.length)];
                    const wStart = Math.floor(rng() * MAX_TIME);
                    const wEnd = wStart + 1 + Math.floor(rng() * 300);
                    const before = serialize(editor);
                    const okA = editor.crop(id, wStart, wEnd);
                    const okB = raster.crop(id, wStart, wEnd);
                    assert.equal(okA, okB, `step ${step}: crop 返回值不一致`);
                    if (okA) {
                        snapshots.push(before);
                        liveIds = editor.list().map((s) => s.id);
                    }
                }
                else {
                    // 撤销
                    const okA = editor.undo();
                    const okB = raster.undo();
                    assert.equal(okA, okB, `step ${step}: undo 返回值不一致`);
                    if (okA) {
                        const expected = snapshots.pop();
                        assert.equal(serialize(editor), expected, `step ${step}: 撤销后未恢复到操作前的同一版本`);
                        liveIds = editor.list().map((s) => s.id);
                    }
                }
                // 每步全量对照：版本、字幕列表、最大连续可见段
                assert.equal(editor.version, raster.version, `step ${step}: version`);
                assert.deepEqual(editor.list(), raster.list(), `step ${step}: list`);
                assert.deepEqual(editor.visibleSegments(), raster.visibleSegments(), `step ${step}: visibleSegments`);
                // 抽样若干毫秒点对照 visibleAt
                for (let k = 0; k < 8; k++) {
                    const t = Math.floor(rng() * (MAX_TIME + 250));
                    assert.deepEqual(editor.visibleAt(t), raster.winnerAt(t), `step ${step}: visibleAt(${t})`);
                }
            }
        });
    }
    it("可见段性质：升序、半开不重叠、段内来源唯一", () => {
        const rng = makeRng(99);
        const editor = new SubtitleEditor();
        for (let i = 0; i < 200; i++) {
            const layer = Math.floor(rng() * 4);
            const start = Math.floor(rng() * 400);
            const end = start + 1 + Math.floor(rng() * 200);
            editor.insert({ layer, start, end, text: `t${i}` });
        }
        const segments = editor.visibleSegments();
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            assert.ok(seg.start < seg.end, "段必须非空");
            assert.equal(editor.visibleAt(seg.start)?.id, seg.source, "段起点来源一致");
            assert.equal(editor.visibleAt(seg.end - 1)?.id, seg.source, "段末点来源一致");
            if (i > 0) {
                const prev = segments[i - 1];
                assert.ok(prev.end <= seg.start, "段之间不重叠且升序");
                if (prev.end === seg.start) {
                    assert.notEqual(prev.source, seg.source, "相邻段来源必须不同（最大连续）");
                }
            }
        }
    });
});
