import { test } from "node:test";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  applyOps,
  batchOps,
  compress,
  invertBatches,
  type Op,
  type Value,
} from "../src/change-log.js";

function sortedEntries(map: Map<string, Value>): [string, Value][] {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function assertStateEqual(
  actual: Map<string, Value>,
  expected: Map<string, Value>,
  message?: string,
): void {
  deepStrictEqual(sortedEntries(actual), sortedEntries(expected), message);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("insert 后 delete：两者消失", () => {
  const { ops, needsBaseline } = compress([
    { type: "insert", key: "k", value: 1 },
    { type: "delete", key: "k", oldValue: 1 },
  ]);
  deepStrictEqual(ops, []);
  deepStrictEqual(needsBaseline, []);
});

test("delete 后 insert：成为 replace 且保存原值", () => {
  const { ops, needsBaseline } = compress([
    { type: "delete", key: "k", oldValue: 1 },
    { type: "insert", key: "k", value: 2 },
  ]);
  deepStrictEqual(ops, [
    { type: "replace", key: "k", oldValue: 1, newValue: 2 },
  ]);
  deepStrictEqual(needsBaseline, []);
});

test("无法知道原值时报需要基线；提供基线后可解析", () => {
  const withoutBaseline = compress([
    { type: "delete", key: "k" },
    { type: "insert", key: "k", value: 2 },
  ]);
  deepStrictEqual(withoutBaseline.ops, [
    { type: "replace", key: "k", newValue: 2 },
  ]);
  deepStrictEqual(withoutBaseline.needsBaseline, ["k"]);

  const baseline = new Map<string, Value>([["k", 1]]);
  const withBaseline = compress(
    [
      { type: "delete", key: "k" },
      { type: "insert", key: "k", value: 2 },
    ],
    baseline,
  );
  deepStrictEqual(withBaseline.ops, [
    { type: "replace", key: "k", oldValue: 1, newValue: 2 },
  ]);
  deepStrictEqual(withBaseline.needsBaseline, []);
});

test("replace 后 delete 成为 delete、连续 replace 合并，均保留最早原值", () => {
  const { ops } = compress([
    { type: "replace", key: "a", oldValue: 1, newValue: 2 },
    { type: "delete", key: "a" },
    { type: "replace", key: "b", oldValue: 10, newValue: 20 },
    { type: "replace", key: "b", oldValue: 20, newValue: 30 },
  ]);
  deepStrictEqual(ops, [
    { type: "delete", key: "a", oldValue: 1 },
    { type: "replace", key: "b", oldValue: 10, newValue: 30 },
  ]);
});

test("逆批次：顺序相反且依次应用可撤销", () => {
  const initial = new Map<string, Value>([
    ["a", 1],
    ["b", 2],
  ]);
  const batches: Op[][] = [
    [
      { type: "replace", key: "a", oldValue: 1, newValue: 10 },
      { type: "insert", key: "c", value: 3 },
    ],
    [{ type: "delete", key: "b", oldValue: 2 }],
  ];

  const { batches: undo, needsBaseline } = invertBatches(batches);
  deepStrictEqual(needsBaseline, []);
  deepStrictEqual(undo, [
    [{ type: "insert", key: "b", value: 2 }],
    [
      { type: "delete", key: "c", oldValue: 3 },
      { type: "replace", key: "a", oldValue: 10, newValue: 1 },
    ],
  ]);

  const state = new Map(initial);
  for (const batch of batches) applyOps(state, batch);
  for (const batch of undo) applyOps(state, batch);
  assertStateEqual(state, initial);
});

test("随机操作：压缩前后结果及撤销相同", () => {
  const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ROUNDS = 200;

  for (let round = 0; round < ROUNDS; round++) {
    const rand = mulberry32(round + 1);
    const pick = <T,>(arr: readonly T[]): T =>
      arr[Math.floor(rand() * arr.length)] as T;

    const initial = new Map<string, Value>();
    for (const key of KEYS) {
      if (rand() < 0.5) initial.set(key, Math.floor(rand() * 1000));
    }

    const opCount = 1 + Math.floor(rand() * 60);
    const ops: Op[] = [];
    const working = new Map(initial);
    for (let i = 0; i < opCount; i++) {
      const key = pick(KEYS);
      const oldValue = working.get(key);
      let op: Op;
      if (!working.has(key)) {
        op = { type: "insert", key, value: Math.floor(rand() * 1000) };
      } else if (rand() < 0.5) {
        op = { type: "delete", key, oldValue };
      } else {
        op = {
          type: "replace",
          key,
          oldValue,
          newValue: Math.floor(rand() * 1000),
        };
      }
      ops.push(op);
      applyOps(working, [op]);
    }

    const tag = `round=${round} ops=${opCount}`;

    const stateRaw = new Map(initial);
    applyOps(stateRaw, ops);
    assertStateEqual(stateRaw, working, `raw apply mismatch (${tag})`);

    const { ops: compressed, needsBaseline } = compress(ops);
    deepStrictEqual(needsBaseline, [], `unexpected needsBaseline (${tag})`);
    ok(compressed.length <= ops.length, `compression grew (${tag})`);

    const stateCompressed = new Map(initial);
    applyOps(stateCompressed, compressed);
    assertStateEqual(stateCompressed, stateRaw, `compressed mismatch (${tag})`);

    const rawUndo = invertBatches(batchOps(ops, 1 + Math.floor(rand() * 7)));
    deepStrictEqual(rawUndo.needsBaseline, [], `raw undo gap (${tag})`);
    for (const batch of rawUndo.batches) applyOps(stateRaw, batch);
    assertStateEqual(stateRaw, initial, `raw undo mismatch (${tag})`);

    const cmpUndo = invertBatches(
      batchOps(compressed, 1 + Math.floor(rand() * 7)),
    );
    deepStrictEqual(cmpUndo.needsBaseline, [], `cmp undo gap (${tag})`);
    for (const batch of cmpUndo.batches) applyOps(stateCompressed, batch);
    assertStateEqual(stateCompressed, initial, `cmp undo mismatch (${tag})`);
  }

  equal(ROUNDS, 200);
});
