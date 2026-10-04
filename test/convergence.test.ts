import { test } from "node:test";
import assert from "node:assert/strict";
import { ORSet, type Message } from "../src/index.js";
import { deliverShuffled, mulberry32, sortedValues } from "./helpers.js";

test("删除先于添加到达（乱序），最终删除生效且各副本一致", () => {
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");
  const c = new ORSet<string>("C");

  const add = a.add("x");
  b.apply(add);
  const remove = b.remove("x");
  assert.ok(remove);

  // C 先收到删除，后收到添加
  c.apply(remove);
  c.apply(add);
  assert.ok(!c.has("x"));

  // A 先收到自己的添加，后收到删除
  a.apply(remove);
  assert.ok(!a.has("x"));

  // 重复投递不改变结果
  c.apply(add);
  c.apply(remove);
  a.apply(remove);
  assert.ok(a.equals(c));
  assert.equal(c.pendingCount, 0);
});

test("同一副本的添加乱序到达时被缓冲，前驱补齐后按序应用", () => {
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");
  const m1 = a.add("one");
  const m2 = a.add("two");
  const m3 = a.add("three");

  b.apply(m3); // 乱序：缓冲
  b.apply(m2); // 乱序：缓冲
  assert.equal(b.size, 0);
  assert.equal(b.pendingCount, 2);
  b.apply(m1); // 前驱到达，排空缓冲
  assert.equal(b.pendingCount, 0);
  assert.deepEqual(sortedValues(b), ["one", "three", "two"]);
  assert.ok(a.equals(b));
});

test("三副本随机操作 + 全消息乱序/重复投递后收敛", () => {
  const rand = mulberry32(20261005);
  const a = new ORSet<string>("A");
  const b = new ORSet<string>("B");
  const c = new ORSet<string>("C");
  const all = [a, b, c];

  // 第一轮：并发添加
  const round1: Message<string>[] = [
    a.add("apple"),
    b.add("banana"),
    c.add("apple"), // 与 A 并发同值，不同 tag
    a.add("cherry"),
  ];
  deliverShuffled(round1, all, rand);
  for (const r of all) {
    assert.deepEqual(sortedValues(r), ["apple", "banana", "cherry"]);
  }
  assert.ok(a.equals(b) && b.equals(c));

  // 第二轮：基于第一轮观察做删除，同时并发新添加
  const round2: Message<string>[] = [];
  const removeApple = b.remove("apple"); // B 观察到 A、C 两处 apple 的 tag
  assert.ok(removeApple);
  assert.equal(removeApple.tags.length, 2);
  round2.push(removeApple);
  round2.push(a.add("apple")); // A 并发重新添加（未看到 B 的删除）→ 必须存活
  const removeBanana = c.remove("banana");
  assert.ok(removeBanana);
  round2.push(removeBanana);
  round2.push(c.add("date"));

  deliverShuffled(round2, all, rand);

  for (const r of all) {
    assert.deepEqual(sortedValues(r), ["apple", "cherry", "date"], "旧删除不得吞掉并发添加");
    assert.equal(r.pendingCount, 0);
  }
  assert.ok(a.equals(b), "A 与 B 收敛");
  assert.ok(b.equals(c), "B 与 C 收敛");
});

test("多种子随机投递顺序均收敛到同一状态", () => {
  for (const seed of [1, 7, 42, 999]) {
    const rand = mulberry32(seed);
    const a = new ORSet<string>("A");
    const b = new ORSet<string>("B");
    const c = new ORSet<string>("C");
    const all = [a, b, c];

    const messages: Message<string>[] = [
      a.add("x"), a.add("y"), b.add("x"), c.add("z"), b.add("w"),
    ];
    deliverShuffled(messages, all, rand);
    const removeX = a.remove("x"); // A 观察到自己和 B 的 x
    assert.ok(removeX);
    const round2: Message<string>[] = [removeX, c.add("x")]; // C 并发补回 x
    deliverShuffled(round2, all, rand);

    assert.deepEqual(sortedValues(a), ["w", "x", "y", "z"]);
    assert.ok(a.equals(b) && b.equals(c), `seed=${seed} 应收敛`);
  }
});
