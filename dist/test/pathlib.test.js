"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const level_1 = require("../src/level");
const state_1 = require("../src/state");
const bfs_1 = require("../src/bfs");
const replay_1 = require("../src/replay");
// ---------- 关卡解析与约束 ----------
(0, node_test_1.test)("解析合法关卡：尺寸、起点、终点、钥匙与门", () => {
    const level = (0, level_1.parseLevel)([
        "S.a#",
        "##A#",
        "#..G",
    ]);
    strict_1.default.equal(level.width, 4);
    strict_1.default.equal(level.height, 3);
    strict_1.default.equal(level.numKeys, 1);
    strict_1.default.equal(level.keyAt.size, 1);
    strict_1.default.equal(level.doorAt.size, 1);
});
(0, node_test_1.test)("拒绝超过 10x10 的网格", () => {
    const wide = ["S" + ".".repeat(level_1.MAX_SIZE) + "G"]; // 12 列
    strict_1.default.throws(() => (0, level_1.parseLevel)(wide), /exceeds/);
    const tall = Array(level_1.MAX_SIZE + 1).fill("S.G"); // 11 行
    strict_1.default.throws(() => (0, level_1.parseLevel)(tall), /exceeds/);
});
(0, node_test_1.test)("拒绝超过 5 把钥匙", () => {
    // 字符集 a-e 本身限定钥匙 ≤5；第 6 把钥匙字符非法
    strict_1.default.throws(() => (0, level_1.parseLevel)(["SafG"]), /unknown cell char/);
    // 同 id 钥匙不可重复
    strict_1.default.throws(() => (0, level_1.parseLevel)(["Sa.a", "...G"]), /duplicate key/);
    // 5 把钥匙是合法上限
    strict_1.default.ok((0, level_1.parseLevel)(["Sabcde", "ABCDE.", "G....."]));
});
(0, node_test_1.test)("拒绝没有对应钥匙的门", () => {
    strict_1.default.throws(() => (0, level_1.parseLevel)(["SAG"]), /no matching key/);
});
(0, node_test_1.test)("拒绝缺少起点或终点", () => {
    strict_1.default.throws(() => (0, level_1.parseLevel)(["S.."]), /missing goal/);
    strict_1.default.throws(() => (0, level_1.parseLevel)(["..G"]), /missing start/);
});
// ---------- 基础移动与 BFS ----------
(0, node_test_1.test)("无障碍最短路径", () => {
    const level = (0, level_1.parseLevel)([
        "S..",
        "..G",
    ]);
    const r = (0, bfs_1.solve)(level);
    strict_1.default.ok(r);
    strict_1.default.equal(r.actions.length, 3); // 曼哈顿距离
    strict_1.default.ok((0, replay_1.verifyPath)(level, r.actions));
});
(0, node_test_1.test)("绕墙最短路径", () => {
    const level = (0, level_1.parseLevel)([
        "S#..",
        ".#.#",
        ".#.#",
        "...G",
    ]);
    const r = (0, bfs_1.solve)(level);
    strict_1.default.equal(r.actions.length, 6);
    strict_1.default.ok((0, replay_1.verifyPath)(level, r.actions));
});
(0, node_test_1.test)("无解地图返回 null", () => {
    const level = (0, level_1.parseLevel)([
        "S#.",
        "###",
        "..G",
    ]);
    strict_1.default.equal((0, bfs_1.solve)(level), null);
});
// ---------- 钥匙与单次门 ----------
(0, node_test_1.test)("拾取钥匙开门到达终点，且为最短路径", () => {
    const level = (0, level_1.parseLevel)([
        "S.a..",
        "###..",
        "..A..",
        "..###",
        "..G..",
    ]);
    const r = (0, bfs_1.solve)(level);
    // 上下两区仅由门 A 连接：S->a->绕行至 A 6 步，A->G 4 步
    strict_1.default.equal(r.actions.length, 10);
    strict_1.default.ok((0, replay_1.verifyPath)(level, r.actions));
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(r.goal)), 0); // 钥匙已被门消耗
});
(0, node_test_1.test)("单次门消耗钥匙：开门后钥匙不再持有", () => {
    const level = (0, level_1.parseLevel)(["SaAG"]);
    const store = new state_1.StateStore(level);
    const s0 = store.initial();
    const s1 = store.apply(s0, "right"); // 拾取 a
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(s1)), 1);
    const s2 = store.apply(s1, "right"); // 开门 A，消耗钥匙
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(s2)), 0);
    strict_1.default.equal(s2.doorsOpen, 1);
    const s3 = store.apply(s2, "right"); // 穿过已开的门到达 G
    strict_1.default.equal(s3.pos, level.goal);
});
(0, node_test_1.test)("无钥匙时门不可通过", () => {
    const level = (0, level_1.parseLevel)(["SAG", "a.."]);
    const store = new state_1.StateStore(level);
    const s0 = store.initial();
    strict_1.default.equal(store.apply(s0, "right"), null); // 没有钥匙，撞门
});
(0, node_test_1.test)("多把钥匙多扇门的最短路径", () => {
    // 线性走廊：依次拾 a 开 A、拾 b 开 B
    const level = (0, level_1.parseLevel)(["SaAbB.G"]);
    const r = (0, bfs_1.solve)(level);
    strict_1.default.ok(r);
    strict_1.default.equal(r.actions.length, 6);
    strict_1.default.ok((0, replay_1.verifyPath)(level, r.actions));
    strict_1.default.equal((0, state_1.popcount)(r.goal.doorsOpen), 2);
});
// ---------- 撤销与版本分叉 ----------
(0, node_test_1.test)("撤销开门：门恢复关闭，已消耗钥匙返还", () => {
    const level = (0, level_1.parseLevel)(["SaA.G"]);
    const store = new state_1.StateStore(level);
    const s0 = store.initial();
    const s1 = store.apply(s0, "right"); // 拾钥匙
    const s2 = store.apply(s1, "right"); // 开门（消耗钥匙）
    strict_1.default.equal(s2.doorsOpen, 1);
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(s2)), 0);
    const back = store.undo(s2); // 撤销开门
    strict_1.default.equal(back.version, s1.version);
    strict_1.default.equal(back.doorsOpen, 0); // 门恢复关闭
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(back)), 1); // 钥匙返还
    const back2 = store.undo(back); // 撤销拾取
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(back2)), 0);
    strict_1.default.equal(store.undo(back2), null); // 根版本不可再撤销
});
(0, node_test_1.test)("状态版本可分叉：同一历史版本分出互不影响的两条分支", () => {
    const level = (0, level_1.parseLevel)([
        "SaA.G",
        ".....",
    ]);
    const store = new state_1.StateStore(level);
    const s0 = store.initial();
    const s1 = store.apply(s0, "right"); // 拾钥匙 a
    // 分支 1：开门向右
    const branchA = store.apply(s1, "right");
    strict_1.default.equal(branchA.doorsOpen, 1);
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(branchA)), 0);
    // 分支 2：从同一版本向下走，不开门
    const fork = store.fork(s1.version);
    const branchB = store.apply(fork, "down");
    strict_1.default.equal(branchB.doorsOpen, 0); // 门仍关闭
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(branchB)), 1); // 钥匙仍在
    // 分支 1 不受分支 2 影响，反之亦然
    strict_1.default.equal(store.get(branchA.version).doorsOpen, 1);
    strict_1.default.equal(store.get(branchB.version).doorsOpen, 0);
    strict_1.default.equal(branchA.parent, branchB.parent); // 共同祖先 = 分叉点
});
(0, node_test_1.test)("从分叉版本继续求解最短路径", () => {
    const level = (0, level_1.parseLevel)([
        "SaA.G",
        ".....",
    ]);
    const store = new state_1.StateStore(level);
    const s0 = store.initial();
    const s1 = store.apply(s0, "right"); // 已拾钥匙的版本
    const r = (0, bfs_1.solve)(level, s1, store); // 从分叉版本继续 BFS
    strict_1.default.ok(r);
    strict_1.default.equal(r.actions.length, 3); // right(开门) + right + right
    strict_1.default.equal(r.goal.pos, level.goal);
});
// ---------- 路径重放核验 ----------
(0, node_test_1.test)("重放核验：BFS 解重放后到达终点", () => {
    const level = (0, level_1.parseLevel)([
        "S.a#.",
        "##A#.",
        "#..b.",
        ".##B.",
        "....G",
    ]);
    const r = (0, bfs_1.solve)(level);
    const rep = (0, replay_1.replayPath)(level, r.actions);
    strict_1.default.ok(rep.ok);
    strict_1.default.ok(rep.reachedGoal);
    strict_1.default.equal(rep.trajectory.length, r.actions.length + 1);
});
(0, node_test_1.test)("重放核验：篡改的路径被检出", () => {
    const level = (0, level_1.parseLevel)(["SaAG"]);
    const bad = (0, replay_1.replayPath)(level, ["right", "right", "right", "right"]);
    // 前 3 步合法且已到 G，第 4 步出界非法
    strict_1.default.equal(bad.ok, false);
    strict_1.default.equal(bad.failedAt, 3);
    strict_1.default.equal(bad.reachedGoal, false);
    const worse = (0, replay_1.replayPath)(level, ["left"]); // 出界
    strict_1.default.equal(worse.ok, false);
    strict_1.default.equal(worse.failedAt, 0);
    const noKey = (0, replay_1.replayPath)((0, level_1.parseLevel)(["SAG", "a.."]), ["right"]);
    strict_1.default.equal(noKey.ok, false); // 无钥匙撞门
});
(0, node_test_1.test)("重放核验：undo 后的版本与重放前缀一致", () => {
    const level = (0, level_1.parseLevel)(["SaA.G"]);
    const r = (0, bfs_1.solve)(level);
    const rep = (0, replay_1.replayPath)(level, r.actions);
    strict_1.default.ok(rep.ok);
    const store = new state_1.StateStore(level);
    let cur = store.initial();
    for (const a of r.actions)
        cur = store.apply(cur, a);
    // 从终点撤销两步，应等于重放轨迹中对应前缀版本的状态
    const undone = store.undo(store.undo(cur));
    const prefix = rep.trajectory[rep.trajectory.length - 3];
    strict_1.default.equal(undone.pos, prefix.pos);
    strict_1.default.equal(undone.collected, prefix.collected);
    strict_1.default.equal(undone.doorsOpen, prefix.doorsOpen);
});
// ---------- 综合：10x10 上限网格 ----------
(0, node_test_1.test)("10x10 网格上含 5 钥匙 5 门的最短路径求解与核验", () => {
    const level = (0, level_1.parseLevel)([
        "S...a.....",
        "######.###",
        ".....A.b..",
        "###.######",
        "..B.c.....",
        ".#########",
        ".d......C.",
        "#########.",
        ".D.E.e....",
        "G#########",
    ]);
    strict_1.default.equal(level.numKeys, 5);
    const r = (0, bfs_1.solve)(level);
    strict_1.default.ok(r);
    // 蛇形走廊强制依次穿过全部 5 扇门
    strict_1.default.equal(r.actions.length, 43);
    strict_1.default.equal((0, state_1.popcount)(r.goal.doorsOpen), 5);
    strict_1.default.equal((0, state_1.popcount)((0, state_1.keysHeld)(r.goal)), 0); // 5 把钥匙全部消耗
    strict_1.default.ok((0, replay_1.verifyPath)(level, r.actions));
    strict_1.default.equal(r.goal.pos, level.goal);
});
