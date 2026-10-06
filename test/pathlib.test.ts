import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLevel, MAX_SIZE } from "../src/level";
import { StateStore, keysHeld, popcount } from "../src/state";
import { solve } from "../src/bfs";
import { replayPath, verifyPath } from "../src/replay";

// ---------- 关卡解析与约束 ----------

test("解析合法关卡：尺寸、起点、终点、钥匙与门", () => {
  const level = parseLevel([
    "S.a#",
    "##A#",
    "#..G",
  ]);
  assert.equal(level.width, 4);
  assert.equal(level.height, 3);
  assert.equal(level.numKeys, 1);
  assert.equal(level.keyAt.size, 1);
  assert.equal(level.doorAt.size, 1);
});

test("拒绝超过 10x10 的网格", () => {
  const wide = ["S" + ".".repeat(MAX_SIZE) + "G"]; // 12 列
  assert.throws(() => parseLevel(wide), /exceeds/);
  const tall = Array(MAX_SIZE + 1).fill("S.G"); // 11 行
  assert.throws(() => parseLevel(tall), /exceeds/);
});

test("拒绝超过 5 把钥匙", () => {
  // 字符集 a-e 本身限定钥匙 ≤5；第 6 把钥匙字符非法
  assert.throws(() => parseLevel(["SafG"]), /unknown cell char/);
  // 同 id 钥匙不可重复
  assert.throws(() => parseLevel(["Sa.a", "...G"]), /duplicate key/);
  // 5 把钥匙是合法上限
  assert.ok(parseLevel(["Sabcde", "ABCDE.", "G....."]));
});

test("拒绝没有对应钥匙的门", () => {
  assert.throws(() => parseLevel(["SAG"]), /no matching key/);
});

test("拒绝缺少起点或终点", () => {
  assert.throws(() => parseLevel(["S.."]), /missing goal/);
  assert.throws(() => parseLevel(["..G"]), /missing start/);
});

// ---------- 基础移动与 BFS ----------

test("无障碍最短路径", () => {
  const level = parseLevel([
    "S..",
    "..G",
  ]);
  const r = solve(level)!;
  assert.ok(r);
  assert.equal(r.actions.length, 3); // 曼哈顿距离
  assert.ok(verifyPath(level, r.actions));
});

test("绕墙最短路径", () => {
  const level = parseLevel([
    "S#..",
    ".#.#",
    ".#.#",
    "...G",
  ]);
  const r = solve(level)!;
  assert.equal(r.actions.length, 6);
  assert.ok(verifyPath(level, r.actions));
});

test("无解地图返回 null", () => {
  const level = parseLevel([
    "S#.",
    "###",
    "..G",
  ]);
  assert.equal(solve(level), null);
});

// ---------- 钥匙与单次门 ----------

test("拾取钥匙开门到达终点，且为最短路径", () => {
  const level = parseLevel([
    "S.a..",
    "###..",
    "..A..",
    "..###",
    "..G..",
  ]);
  const r = solve(level)!;
  // 上下两区仅由门 A 连接：S->a->绕行至 A 6 步，A->G 4 步
  assert.equal(r.actions.length, 10);
  assert.ok(verifyPath(level, r.actions));
  assert.equal(popcount(keysHeld(r.goal)), 0); // 钥匙已被门消耗
});

test("单次门消耗钥匙：开门后钥匙不再持有", () => {
  const level = parseLevel(["SaAG"]);
  const store = new StateStore(level);
  const s0 = store.initial();
  const s1 = store.apply(s0, "right")!; // 拾取 a
  assert.equal(popcount(keysHeld(s1)), 1);
  const s2 = store.apply(s1, "right")!; // 开门 A，消耗钥匙
  assert.equal(popcount(keysHeld(s2)), 0);
  assert.equal(s2.doorsOpen, 1);
  const s3 = store.apply(s2, "right")!; // 穿过已开的门到达 G
  assert.equal(s3.pos, level.goal);
});

test("无钥匙时门不可通过", () => {
  const level = parseLevel(["SAG", "a.."]);
  const store = new StateStore(level);
  const s0 = store.initial();
  assert.equal(store.apply(s0, "right"), null); // 没有钥匙，撞门
});

test("多把钥匙多扇门的最短路径", () => {
  // 线性走廊：依次拾 a 开 A、拾 b 开 B
  const level = parseLevel(["SaAbB.G"]);
  const r = solve(level)!;
  assert.ok(r);
  assert.equal(r.actions.length, 6);
  assert.ok(verifyPath(level, r.actions));
  assert.equal(popcount(r.goal.doorsOpen), 2);
});

// ---------- 撤销与版本分叉 ----------

test("撤销开门：门恢复关闭，已消耗钥匙返还", () => {
  const level = parseLevel(["SaA.G"]);
  const store = new StateStore(level);
  const s0 = store.initial();
  const s1 = store.apply(s0, "right")!; // 拾钥匙
  const s2 = store.apply(s1, "right")!; // 开门（消耗钥匙）
  assert.equal(s2.doorsOpen, 1);
  assert.equal(popcount(keysHeld(s2)), 0);

  const back = store.undo(s2)!; // 撤销开门
  assert.equal(back.version, s1.version);
  assert.equal(back.doorsOpen, 0); // 门恢复关闭
  assert.equal(popcount(keysHeld(back)), 1); // 钥匙返还

  const back2 = store.undo(back)!; // 撤销拾取
  assert.equal(popcount(keysHeld(back2)), 0);
  assert.equal(store.undo(back2), null); // 根版本不可再撤销
});

test("状态版本可分叉：同一历史版本分出互不影响的两条分支", () => {
  const level = parseLevel([
    "SaA.G",
    ".....",
  ]);
  const store = new StateStore(level);
  const s0 = store.initial();
  const s1 = store.apply(s0, "right")!; // 拾钥匙 a

  // 分支 1：开门向右
  const branchA = store.apply(s1, "right")!;
  assert.equal(branchA.doorsOpen, 1);
  assert.equal(popcount(keysHeld(branchA)), 0);

  // 分支 2：从同一版本向下走，不开门
  const fork = store.fork(s1.version);
  const branchB = store.apply(fork, "down")!;
  assert.equal(branchB.doorsOpen, 0); // 门仍关闭
  assert.equal(popcount(keysHeld(branchB)), 1); // 钥匙仍在

  // 分支 1 不受分支 2 影响，反之亦然
  assert.equal(store.get(branchA.version).doorsOpen, 1);
  assert.equal(store.get(branchB.version).doorsOpen, 0);
  assert.equal(branchA.parent, branchB.parent); // 共同祖先 = 分叉点
});

test("从分叉版本继续求解最短路径", () => {
  const level = parseLevel([
    "SaA.G",
    ".....",
  ]);
  const store = new StateStore(level);
  const s0 = store.initial();
  const s1 = store.apply(s0, "right")!; // 已拾钥匙的版本
  const r = solve(level, s1, store)!; // 从分叉版本继续 BFS
  assert.ok(r);
  assert.equal(r.actions.length, 3); // right(开门) + right + right
  assert.equal(r.goal.pos, level.goal);
});

// ---------- 路径重放核验 ----------

test("重放核验：BFS 解重放后到达终点", () => {
  const level = parseLevel([
    "S.a#.",
    "##A#.",
    "#..b.",
    ".##B.",
    "....G",
  ]);
  const r = solve(level)!;
  const rep = replayPath(level, r.actions);
  assert.ok(rep.ok);
  assert.ok(rep.reachedGoal);
  assert.equal(rep.trajectory.length, r.actions.length + 1);
});

test("重放核验：篡改的路径被检出", () => {
  const level = parseLevel(["SaAG"]);
  const bad = replayPath(level, ["right", "right", "right", "right"]);
  // 前 3 步合法且已到 G，第 4 步出界非法
  assert.equal(bad.ok, false);
  assert.equal(bad.failedAt, 3);
  assert.equal(bad.reachedGoal, false);
  const worse = replayPath(level, ["left"]); // 出界
  assert.equal(worse.ok, false);
  assert.equal(worse.failedAt, 0);
  const noKey = replayPath(parseLevel(["SAG", "a.."]), ["right"]);
  assert.equal(noKey.ok, false); // 无钥匙撞门
});

test("重放核验：undo 后的版本与重放前缀一致", () => {
  const level = parseLevel(["SaA.G"]);
  const r = solve(level)!;
  const rep = replayPath(level, r.actions);
  assert.ok(rep.ok);
  const store = new StateStore(level);
  let cur = store.initial();
  for (const a of r.actions) cur = store.apply(cur, a)!;
  // 从终点撤销两步，应等于重放轨迹中对应前缀版本的状态
  const undone = store.undo(store.undo(cur)!)!;
  const prefix = rep.trajectory[rep.trajectory.length - 3];
  assert.equal(undone.pos, prefix.pos);
  assert.equal(undone.collected, prefix.collected);
  assert.equal(undone.doorsOpen, prefix.doorsOpen);
});

// ---------- 综合：10x10 上限网格 ----------

test("10x10 网格上含 5 钥匙 5 门的最短路径求解与核验", () => {
  const level = parseLevel([
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
  assert.equal(level.numKeys, 5);
  const r = solve(level)!;
  assert.ok(r);
  // 蛇形走廊强制依次穿过全部 5 扇门
  assert.equal(r.actions.length, 43);
  assert.equal(popcount(r.goal.doorsOpen), 5);
  assert.equal(popcount(keysHeld(r.goal)), 0); // 5 把钥匙全部消耗
  assert.ok(verifyPath(level, r.actions));
  assert.equal(r.goal.pos, level.goal);
});
