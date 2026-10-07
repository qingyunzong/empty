import { test } from "node:test";
import assert from "node:assert/strict";
import { Leaderboard, LeaderboardError, compareUtf8 } from "../src/leaderboard.js";

test("整数分累计，支持负 delta 与负净分", () => {
  const lb = new Leaderboard(10);
  lb.apply({ id: "e1", user: "alice", delta: 5 });
  lb.apply({ id: "e2", user: "alice", delta: -8 });
  lb.apply({ id: "e3", user: "bob", delta: -2 });
  assert.equal(lb.scoreOf("alice"), -3);
  assert.equal(lb.scoreOf("bob"), -2);
  assert.equal(lb.scoreOf("nobody"), 0);
  // 负分也参与排名：-2 高于 -3
  assert.deepEqual(
    lb.ranking().map((e) => [e.rank, e.user, e.score]),
    [
      [1, "bob", -2],
      [2, "alice", -3],
    ]
  );
  lb.verify();
});

test("重复 ID 同内容幂等，不计分也不产生 TopK 变化", () => {
  const lb = new Leaderboard(3);
  lb.apply({ id: "e1", user: "alice", delta: 5 });
  const change = lb.apply({ id: "e1", user: "alice", delta: 5 });
  assert.equal(lb.scoreOf("alice"), 5);
  assert.deepEqual(change, { k: 3, entered: [], left: [], changed: [] });
  lb.verify();
});

test("重复 ID 异内容拒绝，且状态不变", () => {
  const lb = new Leaderboard(3);
  lb.apply({ id: "e1", user: "alice", delta: 5 });
  assert.throws(
    () => lb.apply({ id: "e1", user: "alice", delta: 6 }),
    (err: unknown) => err instanceof LeaderboardError && /conflicting event id: e1/.test((err as Error).message)
  );
  assert.throws(
    () => lb.apply({ id: "e1", user: "bob", delta: 5 }),
    (err: unknown) => err instanceof LeaderboardError && /conflicting event id/.test((err as Error).message)
  );
  assert.equal(lb.scoreOf("alice"), 5);
  assert.equal(lb.scoreOf("bob"), 0);
  lb.verify();
});

test("撤销只能一次：未知 ID、二次撤销、撤销后重放均拒绝", () => {
  const lb = new Leaderboard(3);
  lb.apply({ id: "e1", user: "alice", delta: 7 });
  lb.revoke("e1");
  assert.equal(lb.scoreOf("alice"), 0);
  assert.throws(() => lb.revoke("e1"), /already revoked/);
  assert.throws(() => lb.revoke("ghost"), /unknown event id/);
  assert.throws(() => lb.apply({ id: "e1", user: "alice", delta: 7 }), /already revoked/);
  lb.verify();
});

test("撤销可产生负净分", () => {
  const lb = new Leaderboard(3);
  lb.apply({ id: "e1", user: "alice", delta: 3 });
  lb.apply({ id: "e2", user: "alice", delta: -10 });
  assert.equal(lb.scoreOf("alice"), -7);
  lb.revoke("e1");
  assert.equal(lb.scoreOf("alice"), -10);
  lb.verify();
});

test("排名：分高优先，并列按用户名 UTF-8 字节序", () => {
  const lb = new Leaderboard(10);
  const users = ["𐀀", "￿", "中", "é", "bob", "alice"]; // 全部并列同分
  users.forEach((user, i) => lb.apply({ id: `e${i}`, user, delta: 1 }));
  // UTF-8 字节序: alice < bob < é(C3A9) < 中(E4B8AD) < ￿(EFBFBF) < 𐀀(F0908080)
  assert.deepEqual(
    lb.ranking().map((e) => e.user),
    ["alice", "bob", "é", "中", "￿", "𐀀"]
  );
  // 证明 UTF-8 序与 JS 默认 UTF-16 序不同：UTF-16 下 𐀀(代理对 D800..) 排在 ￿(FFFF) 前
  assert.ok(compareUtf8("￿", "𐀀") < 0);
  assert.ok("￿" > "𐀀"); // UTF-16 码元序相反
  // 分数打破并列
  lb.apply({ id: "boost", user: "中", delta: 5 });
  assert.deepEqual(lb.ranking()[0], { rank: 1, user: "中", score: 6 });
  lb.verify();
});

test("TopK 净变化：entered / left / changed", () => {
  const lb = new Leaderboard(2);
  const c1 = lb.apply({ id: "e1", user: "alice", delta: 5 });
  assert.deepEqual(c1.entered.map((e) => e.user), ["alice"]);
  assert.deepEqual(c1.left, []);

  lb.apply({ id: "e2", user: "bob", delta: 3 });
  // carol 4 分进入 Top2，bob 3 分被挤出
  const c3 = lb.apply({ id: "e3", user: "carol", delta: 4 });
  assert.deepEqual(c3.entered.map((e) => e.user), ["carol"]);
  assert.deepEqual(c3.left.map((e) => e.user), ["bob"]);
  assert.deepEqual(c3.changed, []); // alice 仍是第 1 名 5 分

  // bob +5 到 8 分夺冠：bob 进入，carol 离开，alice 名次 1->2
  const c4 = lb.apply({ id: "e4", user: "bob", delta: 5 });
  assert.deepEqual(c4.entered.map((e) => e.user), ["bob"]);
  assert.deepEqual(c4.left.map((e) => e.user), ["carol"]);
  assert.deepEqual(
    c4.changed.map((c) => [c.user, c.before.rank, c.after.rank, c.after.score]),
    [["alice", 1, 2, 5]]
  );

  // 撤销 e4：bob 掉出 Top2，carol 回到第 2，alice 回到第 1
  const c5 = lb.revoke("e4");
  assert.deepEqual(c5.entered.map((e) => e.user), ["carol"]);
  assert.deepEqual(c5.left.map((e) => e.user), ["bob"]);
  assert.deepEqual(
    c5.changed.map((c) => [c.user, c.before.rank, c.after.rank]),
    [["alice", 2, 1]]
  );
  lb.verify();
});

test("完整账本重算核对：负分与并列", () => {
  const lb = new Leaderboard(4);
  lb.apply({ id: "a1", user: "alice", delta: -5 });
  lb.apply({ id: "a2", user: "alice", delta: 2 });
  lb.apply({ id: "b1", user: "bob", delta: -3 }); // 与 alice 并列 -3
  lb.apply({ id: "c1", user: "carol", delta: 10 });
  lb.apply({ id: "c2", user: "carol", delta: -4 });
  lb.revoke("c2"); // carol 回到 10
  lb.apply({ id: "d1", user: "dave", delta: 0 });
  lb.verify(); // 不抛错即通过
  assert.deepEqual(
    lb.ranking().map((e) => [e.user, e.score]),
    [
      ["carol", 10],
      ["dave", 0],
      ["alice", -3], // 并列 -3，UTF-8 序 alice < bob
      ["bob", -3],
    ]
  );
});

test("verify 能发现增量状态与账本不一致", () => {
  const lb = new Leaderboard(3);
  lb.apply({ id: "e1", user: "alice", delta: 5 });
  lb.verify();
  (lb as unknown as { totals: Map<string, number> }).totals.set("alice", 999);
  assert.throws(() => lb.verify(), /ledger mismatch for user alice: incremental=999, ledger=5/);
});

test("参数校验：非整数 delta、空 id/user、非法 k", () => {
  assert.throws(() => new Leaderboard(0), /positive integer/);
  assert.throws(() => new Leaderboard(1.5), /positive integer/);
  const lb = new Leaderboard(1);
  assert.throws(() => lb.apply({ id: "e1", user: "a", delta: 1.5 }), /must be an integer/);
  assert.throws(() => lb.apply({ id: "e1", user: "a", delta: Number.NaN }), /must be an integer/);
  assert.throws(() => lb.apply({ id: "", user: "a", delta: 1 }), /non-empty string/);
  assert.throws(() => lb.apply({ id: "e1", user: "", delta: 1 }), /non-empty string/);
  lb.verify();
});
