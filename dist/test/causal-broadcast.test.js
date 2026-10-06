import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { CausalBroadcast, } from '../src/causal-broadcast.js';
function msg(source, seq, deps = {}, content = `${source}#${seq}`, id = `${source}#${seq}`) {
    return { id, source, seq, deps, content };
}
describe('基本交付', () => {
    test('按序到达立即交付', () => {
        const bc = new CausalBroadcast();
        const r1 = bc.receive(msg('A', 1));
        assert.equal(r1.status, 'delivered');
        const r2 = bc.receive(msg('A', 2));
        assert.equal(r2.status, 'delivered');
        assert.deepEqual(bc.delivered().map((m) => m.id), ['A#1', 'A#2']);
    });
    test('前驱未到则暂存并给出待决原因，前驱到达后级联交付', () => {
        const bc = new CausalBroadcast();
        const r3 = bc.receive(msg('A', 3));
        assert.equal(r3.status, 'buffered');
        if (r3.status === 'buffered') {
            assert.deepEqual(r3.reasons, [
                { kind: 'missing-predecessor', source: 'A', expectedSeq: 1 },
            ]);
        }
        bc.receive(msg('A', 2));
        assert.deepEqual(bc.pending().map((p) => p.id), ['A#3', 'A#2']);
        assert.deepEqual(bc.pendingReasons('A#3'), [
            { kind: 'missing-predecessor', source: 'A', expectedSeq: 1 },
        ]);
        const r1 = bc.receive(msg('A', 1));
        assert.equal(r1.status, 'delivered');
        if (r1.status === 'delivered') {
            assert.deepEqual(r1.delivered.map((m) => m.id), ['A#1', 'A#2', 'A#3']);
        }
        assert.equal(bc.pending().length, 0);
    });
    test('依赖向量未满足则暂存，原因含缺失依赖', () => {
        const bc = new CausalBroadcast();
        bc.receive(msg('A', 1));
        const r = bc.receive(msg('B', 1, { A: 2 }));
        assert.equal(r.status, 'buffered');
        if (r.status === 'buffered') {
            assert.deepEqual(r.reasons, [
                { kind: 'missing-dependency', source: 'A', requiredSeq: 2, deliveredSeq: 1 },
            ]);
        }
        const r2 = bc.receive(msg('A', 2));
        assert.equal(r2.status, 'delivered');
        if (r2.status === 'delivered') {
            assert.deepEqual(r2.delivered.map((m) => m.id), ['A#2', 'B#1']);
        }
    });
});
describe('重复与冲突', () => {
    test('同 ID 同内容幂等忽略', () => {
        const bc = new CausalBroadcast();
        bc.receive(msg('A', 1));
        const dup = bc.receive(msg('A', 1));
        assert.equal(dup.status, 'duplicate');
        assert.equal(bc.delivered().length, 1);
    });
    test('同 ID 异内容拒绝', () => {
        const bc = new CausalBroadcast();
        bc.receive(msg('A', 1, {}, 'hello'));
        const r = bc.receive(msg('A', 1, {}, 'tampered'));
        assert.equal(r.status, 'rejected');
        if (r.status === 'rejected') {
            assert.deepEqual(r.reason, { kind: 'conflicting-duplicate', id: 'A#1' });
        }
        assert.equal(bc.delivered().length, 1);
    });
    test('同源同序号异 ID 拒绝', () => {
        const bc = new CausalBroadcast();
        bc.receive(msg('A', 1));
        const r = bc.receive(msg('A', 1, {}, 'other', 'A#1-alt'));
        assert.equal(r.status, 'rejected');
        if (r.status === 'rejected') {
            assert.deepEqual(r.reason, {
                kind: 'conflicting-sequence',
                source: 'A',
                seq: 1,
                existingId: 'A#1',
            });
        }
    });
    test('非法序号拒绝', () => {
        const bc = new CausalBroadcast();
        const r = bc.receive(msg('A', 0));
        assert.equal(r.status, 'rejected');
        if (r.status === 'rejected') {
            assert.equal(r.reason.kind, 'invalid-sequence');
        }
    });
});
describe('水位', () => {
    test('水位声明后旧消息被拒绝', () => {
        const bc = new CausalBroadcast();
        bc.receive(msg('A', 1));
        bc.receive(msg('A', 2));
        bc.declareWatermark('A', 2);
        const late = bc.receive(msg('A', 2, {}, 'late', 'A#2-late'));
        assert.equal(late.status, 'rejected');
        if (late.status === 'rejected') {
            assert.deepEqual(late.reason, {
                kind: 'below-watermark',
                source: 'A',
                seq: 2,
                watermark: 2,
            });
        }
        const old = bc.receive(msg('A', 1, {}, 'old', 'A#1-late'));
        assert.equal(old.status, 'rejected');
    });
    test('水位覆盖序号空洞，放行被阻塞的后续消息', () => {
        const bc = new CausalBroadcast();
        bc.receive(msg('A', 1));
        const blocked = bc.receive(msg('A', 4));
        assert.equal(blocked.status, 'buffered');
        assert.deepEqual(bc.pendingReasons('A#4'), [
            { kind: 'missing-predecessor', source: 'A', expectedSeq: 2 },
        ]);
        const freed = bc.declareWatermark('A', 3);
        assert.deepEqual(freed.map((m) => m.id), ['A#4']);
        assert.equal(bc.deliveredSeqOf('A'), 4);
    });
    test('水位满足依赖向量缺口', () => {
        const bc = new CausalBroadcast();
        const blocked = bc.receive(msg('B', 1, { A: 5 }));
        assert.equal(blocked.status, 'buffered');
        const freed = bc.declareWatermark('A', 5);
        assert.deepEqual(freed.map((m) => m.id), ['B#1']);
    });
    test('水位只升不降', () => {
        const bc = new CausalBroadcast();
        bc.declareWatermark('A', 5);
        bc.declareWatermark('A', 3);
        assert.equal(bc.watermarkOfSource('A'), 5);
    });
});
describe('任意重排 vs 拓扑参考（因果不越过）', () => {
    function mulberry32(seed) {
        let a = seed >>> 0;
        return () => {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    /** 生成随机因果历史：多源各自递增序号，随机合并他源向量时钟作为依赖 */
    function generateHistory(seed, sources, perSource) {
        const rand = mulberry32(seed);
        const clocks = new Map(sources.map((s) => [s, {}]));
        const messages = [];
        const edges = [];
        for (const source of sources) {
            const clock = clocks.get(source);
            for (let seq = 1; seq <= perSource; seq++) {
                // 以一定概率“接收”他源当前时钟，形成跨源依赖
                for (const other of sources) {
                    if (other === source)
                        continue;
                    if (rand() < 0.4) {
                        const otherClock = clocks.get(other);
                        for (const [k, v] of Object.entries(otherClock)) {
                            clock[k] = Math.max(clock[k] ?? 0, v);
                        }
                    }
                }
                clock[source] = seq;
                const deps = {};
                for (const [k, v] of Object.entries(clock)) {
                    if (k !== source && v > 0)
                        deps[k] = v;
                }
                const id = `${source}#${seq}`;
                messages.push({ id, source, seq, deps, content: { payload: id } });
                if (seq > 1)
                    edges.push([`${source}#${seq - 1}`, id]);
                for (const [k, v] of Object.entries(deps)) {
                    edges.push([`${k}#${v}`, id]);
                }
            }
        }
        return { messages, edges };
    }
    function shuffle(items, rand) {
        const arr = [...items];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }
    /** 参考核验：交付序列是否为约束边的线性扩展（拓扑序） */
    function assertLinearExtension(delivered, edges) {
        const position = new Map();
        delivered.forEach((m, i) => position.set(m.id, i));
        for (const [before, after] of edges) {
            const pb = position.get(before);
            const pa = position.get(after);
            assert.ok(pb !== undefined, `前驱 ${before} 未交付`);
            assert.ok(pa !== undefined, `后继 ${after} 未交付`);
            assert.ok(pb < pa, `因果被越过：${before} 必须先于 ${after}`);
        }
    }
    /** 逐步核验：交付的每一步，其前驱与依赖向量均已满足 */
    function assertStepwiseCausality(delivered) {
        const deliveredSeq = new Map();
        for (const m of delivered) {
            const prev = deliveredSeq.get(m.source) ?? 0;
            assert.equal(m.seq, prev + 1, `${m.id} 的每源序号不连续`);
            for (const [depSource, required] of Object.entries(m.deps)) {
                const got = deliveredSeq.get(depSource) ?? 0;
                assert.ok(got >= required, `${m.id} 交付时依赖 ${depSource}@${required} 未满足（仅 ${got}）`);
            }
            deliveredSeq.set(m.source, m.seq);
        }
    }
    for (const seed of [1, 7, 42, 1337, 20261007]) {
        test(`随机历史 seed=${seed}：任意输入重排最终全部交付且不越过因果`, () => {
            const { messages, edges } = generateHistory(seed, ['A', 'B', 'C', 'D'], 25);
            const rand = mulberry32(seed * 1000 + 1);
            for (let round = 0; round < 5; round++) {
                const bc = new CausalBroadcast();
                const order = shuffle(messages, rand);
                for (const m of order) {
                    const r = bc.receive(m);
                    assert.ok(r.status === 'delivered' || r.status === 'buffered', `消息 ${m.id} 被意外拒绝/重复：${r.status}`);
                }
                assert.equal(bc.pending().length, 0, '所有前驱到齐后不应仍有暂存');
                assert.equal(bc.delivered().length, messages.length, '交付总数应等于消息总数');
                assertLinearExtension(bc.delivered(), edges);
                assertStepwiseCausality(bc.delivered());
            }
        });
    }
    test('拓扑序参考：交付日志与 Kahn 参考同集合且为合法线性扩展', () => {
        const { messages, edges } = generateHistory(99, ['X', 'Y', 'Z'], 30);
        const bc = new CausalBroadcast();
        for (const m of shuffle(messages, mulberry32(5))) {
            bc.receive(m);
        }
        // Kahn 参考拓扑排序
        const indegree = new Map(messages.map((m) => [m.id, 0]));
        const adj = new Map();
        for (const [a, b] of edges) {
            indegree.set(b, (indegree.get(b) ?? 0) + 1);
            adj.set(a, [...(adj.get(a) ?? []), b]);
        }
        const queue = messages.filter((m) => indegree.get(m.id) === 0).map((m) => m.id);
        const reference = [];
        while (queue.length > 0) {
            const id = queue.shift();
            reference.push(id);
            for (const next of adj.get(id) ?? []) {
                indegree.set(next, indegree.get(next) - 1);
                if (indegree.get(next) === 0)
                    queue.push(next);
            }
        }
        assert.equal(reference.length, messages.length, '历史必须是无环的');
        assert.deepEqual(new Set(bc.delivered().map((m) => m.id)), new Set(reference), '交付集合应与拓扑参考一致');
        assertLinearExtension(bc.delivered(), edges);
    });
    test('重排过程中暂存原因始终非空且最终清空', () => {
        const { messages } = generateHistory(3, ['P', 'Q'], 15);
        const bc = new CausalBroadcast();
        for (const m of shuffle(messages, mulberry32(77))) {
            const r = bc.receive(m);
            if (r.status === 'buffered') {
                assert.ok(r.reasons.length > 0, '暂存必须给出待决原因');
                for (const entry of bc.pending()) {
                    assert.ok(entry.reasons.length > 0, `暂存消息 ${entry.id} 缺少待决原因`);
                }
            }
        }
        assert.equal(bc.pending().length, 0);
    });
});
