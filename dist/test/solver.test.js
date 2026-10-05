import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, checkSchedule, compile } from "../src/solver.js";
import { bruteMakespan } from "../src/brute.js";
function expectMakespan(inst, expected) {
    const sol = solve(inst);
    if (expected === null) {
        assert.equal(sol, null, "应判定为时间上限内不可行");
        return;
    }
    assert.ok(sol, "应找到可行调度");
    assert.equal(sol.makespan, expected, `makespan 应为 ${expected}`);
    assert.deepEqual(checkSchedule(inst, sol), [], "时间轴必须通过约束校验");
}
test("依赖链强制串行", () => {
    expectMakespan({
        tasks: [
            { id: "t1", duration: 3, workers: 1 },
            { id: "t2", duration: 4, workers: 1, deps: ["t1"] },
            { id: "t3", duration: 2, workers: 1, deps: ["t2"] },
        ],
    }, 9);
});
test("无依赖任务双人并行装箱", () => {
    expectMakespan({
        tasks: [1, 2, 3, 4].map((k) => ({ id: `t${k}`, duration: 2, workers: 1 })),
    }, 4);
});
test("技能约束：A/B 专属任务可并行", () => {
    expectMakespan({
        tasks: [
            { id: "a", duration: 3, workers: 1, skill: "A" },
            { id: "b", duration: 5, workers: 1, skill: "B" },
        ],
    }, 5);
});
test("技能约束：同一人专属任务只能串行", () => {
    expectMakespan({
        tasks: [
            { id: "a1", duration: 3, workers: 1, skill: "A" },
            { id: "a2", duration: 5, workers: 1, skill: "A" },
        ],
    }, 8);
});
test("双人任务同步占用两人", () => {
    const inst = {
        tasks: [
            { id: "joint", duration: 4, workers: 2 },
            { id: "x", duration: 2, workers: 1, skill: "A" },
            { id: "y", duration: 3, workers: 1, skill: "B" },
        ],
    };
    expectMakespan(inst, 7);
    const sol = solve(inst);
    const joint = sol.entries.find((e) => e.taskId === "joint");
    assert.deepEqual(joint.workers, [0, 1], "双人任务必须同步占两人");
});
test("依赖 + 双人任务：等待前置完成后再同步开工", () => {
    // C(B,2) -> D(双人,5)；X(A,4)。最优：X 0-4，C 0-2，D 4-9。
    expectMakespan({
        tasks: [
            { id: "C", duration: 2, workers: 1, skill: "B" },
            { id: "D", duration: 5, workers: 2, deps: ["C"] },
            { id: "X", duration: 4, workers: 1, skill: "A" },
        ],
    }, 9);
});
test("故意空闲严格更优：非延迟调度只能得到 13，最优为 11", () => {
    // t0(B,5)；t1(A,5)<-t0；t2(any,3)；t3(双人,1)<-t2；t4(any,4)。
    // 最优：A 做 t2(0-3) 后【故意空闲 3-5】等 B 完成 t0，
    //   双人任务 t3 于 5-6 同步开工，t1 6-11，t4 由 B 6-10 => 11。
    // 若 t=3 时 A 不空闲而接 t4(3-7)，则 t3 被挤到 7-8、t1 8-13 => 13。
    // （由非延迟变体对照实验确认：禁止空闲时最优仅为 13。）
    const inst = {
        tasks: [
            { id: "t0", duration: 5, workers: 1, skill: "B" },
            { id: "t1", duration: 5, workers: 1, skill: "A", deps: ["t0"] },
            { id: "t2", duration: 3, workers: 1, skill: "any" },
            { id: "t3", duration: 1, workers: 2, deps: ["t2"] },
            { id: "t4", duration: 4, workers: 1, skill: "any" },
        ],
    };
    expectMakespan(inst, 11);
    const sol = solve(inst);
    const a = sol.entries.filter((e) => e.workers.includes(0)).sort((x, y) => x.start - y.start);
    const hasIdleGap = a.some((e, k) => k > 0 && e.start > a[k - 1].end);
    assert.ok(hasIdleGap, "最优时间轴中工人A应存在故意空闲段");
});
test("超出时间上限判定不可行", () => {
    expectMakespan({
        horizon: 10,
        tasks: [
            { id: "t1", duration: 6, workers: 1 },
            { id: "t2", duration: 6, workers: 1, deps: ["t1"] },
        ],
    }, null);
});
test("依赖环判定非法", () => {
    assert.throws(() => compile({
        tasks: [
            { id: "a", duration: 1, workers: 1, deps: ["b"] },
            { id: "b", duration: 1, workers: 1, deps: ["a"] },
        ],
    }));
});
test("非法输入：未知依赖 / 重复 id / 超上限任务数", () => {
    assert.throws(() => compile({ tasks: [{ id: "a", duration: 1, workers: 1, deps: ["ghost"] }] }));
    assert.throws(() => compile({
        tasks: [
            { id: "a", duration: 1, workers: 1 },
            { id: "a", duration: 1, workers: 1 },
        ],
    }));
    assert.throws(() => compile({
        tasks: Array.from({ length: 15 }, (_, k) => ({
            id: `t${k}`,
            duration: 1,
            workers: 1,
        })),
    }));
});
test("14 任务混合实例：与暴力核对一致", () => {
    const inst = {
        tasks: [
            { id: "t1", duration: 3, workers: 1, skill: "A" },
            { id: "t2", duration: 2, workers: 1, skill: "B" },
            { id: "t3", duration: 4, workers: 2, deps: ["t1", "t2"] },
            { id: "t4", duration: 1, workers: 1, skill: "any", deps: ["t1"] },
            { id: "t5", duration: 5, workers: 1, skill: "B", deps: ["t3"] },
            { id: "t6", duration: 2, workers: 2, deps: ["t3"] },
            { id: "t7", duration: 3, workers: 1, skill: "A", deps: ["t4"] },
            { id: "t8", duration: 1, workers: 1, skill: "any", deps: ["t5"] },
            { id: "t9", duration: 2, workers: 1, skill: "B", deps: ["t6"] },
            { id: "t10", duration: 3, workers: 2, deps: ["t7", "t8"] },
            { id: "t11", duration: 1, workers: 1, skill: "A", deps: ["t9"] },
            { id: "t12", duration: 2, workers: 1, skill: "any", deps: ["t10"] },
            { id: "t13", duration: 4, workers: 1, skill: "B", deps: ["t11"] },
            { id: "t14", duration: 1, workers: 2, deps: ["t12", "t13"] },
        ],
    };
    const sol = solve(inst);
    assert.ok(sol);
    assert.deepEqual(checkSchedule(inst, sol), []);
    assert.equal(sol.makespan, bruteMakespan(inst));
});
// —— 随机小实例：事件驱动搜索 vs 逐刻暴力搜索 交叉核对 ——
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
function randomInstance(rand, n) {
    const tasks = [];
    for (let i = 0; i < n; i++) {
        const deps = [];
        for (let j = 0; j < i; j++) {
            if (rand() < 0.25)
                deps.push(`t${j}`);
        }
        const two = rand() < 0.25;
        tasks.push({
            id: `t${i}`,
            duration: 1 + Math.floor(rand() * 6),
            workers: two ? 2 : 1,
            skill: two ? undefined : ["A", "B", "any"][Math.floor(rand() * 3)],
            deps: deps.length > 0 ? deps : undefined,
        });
    }
    return { horizon: 40, tasks };
}
test("随机小实例交叉核对（300 例）", () => {
    const rand = mulberry32(20261006);
    let feasible = 0;
    let infeasible = 0;
    for (let k = 0; k < 300; k++) {
        const n = 2 + Math.floor(rand() * 7); // 2..8 个任务
        const inst = randomInstance(rand, n);
        const sol = solve(inst);
        const brute = bruteMakespan(inst);
        if (sol === null) {
            assert.equal(brute, null, `实例 ${k}：求解器不可行但暴力可行`);
            infeasible++;
        }
        else {
            assert.equal(brute, sol.makespan, `实例 ${k}：两者 makespan 不一致`);
            assert.deepEqual(checkSchedule(inst, sol), [], `实例 ${k}：时间轴非法`);
            feasible++;
        }
    }
    assert.ok(feasible > 0, "应存在可行实例");
    console.log(`  交叉核对通过：可行 ${feasible} 例，上限内不可行 ${infeasible} 例`);
});
