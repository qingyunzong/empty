import { test } from "node:test";
import assert from "node:assert/strict";
import {
  solve,
  validateInput,
  computeDp,
  computeReachableForward,
  MAX_BILLS,
} from "../src/solver.js";
import { solveBruteForce } from "../src/bruteforce.js";
import { buildCertificate, verifyCertificate } from "../src/certificate.js";
import type { Bill, ClearingInput } from "../src/types.js";

function run(input: ClearingInput) {
  const result = solve(input);
  const cert = buildCertificate(input, result.paidOrder, result.refused);
  const errors = verifyCertificate(input, result, cert);
  assert.deepEqual(errors, [], `证书应自洽: ${errors.join("; ")}`);
  return { result, cert };
}

// ---------- 手工算例 ----------

test("链式依赖：必须先 A→B 才能 B→C，全付清，罚费 0", () => {
  const input: ClearingInput = {
    balances: { A: 10, B: 0, C: 0 },
    bills: [
      { id: "b1", from: "B", to: "C", amount: 10, penalty: 9 },
      { id: "b2", from: "A", to: "B", amount: 10, penalty: 1 },
    ],
  };
  const { result, cert } = run(input);
  assert.equal(result.minPenalty, 0);
  assert.deepEqual(result.paidOrder, [1, 0]); // 唯一合法序：先 b2 后 b1
  assert.equal(result.legalOrderCount, 1n);
  assert.deepEqual(cert.finalBalances, { A: 0, B: 0, C: 10 });
});

test("余额不足且无法周转：只能拒付，罚费照计", () => {
  const input: ClearingInput = {
    balances: { A: 5, B: 0 },
    bills: [{ id: "b1", from: "A", to: "B", amount: 10, penalty: 7 }],
  };
  const { result } = run(input);
  assert.equal(result.minPenalty, 7);
  assert.deepEqual(result.paidOrder, []);
  assert.deepEqual(result.refused, [0]);
});

test("同一付款方余额只够一笔：优先支付罚费高的票据", () => {
  const input: ClearingInput = {
    balances: { A: 10, B: 0, C: 0 },
    bills: [
      { id: "b1", from: "A", to: "B", amount: 10, penalty: 1 },
      { id: "b2", from: "A", to: "C", amount: 10, penalty: 5 },
    ],
  };
  const { result } = run(input);
  assert.equal(result.minPenalty, 1);
  assert.deepEqual(result.paidOrder, [1]);
  assert.deepEqual(result.refused, [0]);
});

test("循环债务互相卡死：两笔都只能拒付", () => {
  const input: ClearingInput = {
    balances: { A: 5, B: 5 },
    bills: [
      { id: "b1", from: "A", to: "B", amount: 10, penalty: 3 },
      { id: "b2", from: "B", to: "A", amount: 10, penalty: 4 },
    ],
  };
  const { result } = run(input);
  assert.equal(result.minPenalty, 7);
  assert.deepEqual(result.paidOrder, []);
});

test("循环债务但有一笔外部注资可解开：罚费 0", () => {
  const input: ClearingInput = {
    balances: { A: 5, B: 5, C: 10 },
    bills: [
      { id: "b1", from: "A", to: "B", amount: 10, penalty: 3 },
      { id: "b2", from: "B", to: "A", amount: 10, penalty: 4 },
      { id: "b3", from: "C", to: "A", amount: 5, penalty: 100 },
    ],
  };
  const { result } = run(input);
  assert.equal(result.minPenalty, 0);
  assert.equal(result.paidOrder[0], 2); // 必须先执行 b3
});


test("两笔独立票据：两个执行序都合法，legalOrderCount = 2", () => {
  const input: ClearingInput = {
    balances: { A: 100, B: 100 },
    bills: [
      { id: "b1", from: "A", to: "B", amount: 1, penalty: 1 },
      { id: "b2", from: "B", to: "A", amount: 1, penalty: 1 },
    ],
  };
  const { result } = run(input);
  assert.equal(result.minPenalty, 0);
  assert.equal(result.legalOrderCount, 2n);
  assert.equal(result.feasibleSubsetCount, 4);
});

test("罚费为 0 的票据可直接拒付", () => {
  const input: ClearingInput = {
    balances: { A: 0, B: 0 },
    bills: [{ id: "b1", from: "A", to: "B", amount: 5, penalty: 0 }],
  };
  const { result } = run(input);
  assert.equal(result.minPenalty, 0);
  assert.deepEqual(result.paidOrder, []);
});

test("非法执行序会被证书模拟拒绝", () => {
  const input: ClearingInput = {
    balances: { A: 10, B: 0, C: 0 },
    bills: [
      { id: "b1", from: "B", to: "C", amount: 10, penalty: 9 },
      { id: "b2", from: "A", to: "B", amount: 10, penalty: 1 },
    ],
  };
  assert.throws(() => buildCertificate(input, [0, 1], []), /余额 .* 不足/);
});

// ---------- 输入校验 ----------

test("输入校验：超过 16 笔、非整数、负罚费、缺账户、id 重复均报错", () => {
  const bills17: Bill[] = Array.from({ length: MAX_BILLS + 1 }, (_, i) => ({
    id: `b${i}`,
    from: "A",
    to: "B",
    amount: 1,
    penalty: 1,
  }));
  assert.throws(() => validateInput({ balances: { A: 1, B: 1 }, bills: bills17 }), /至多/);
  assert.throws(
    () => validateInput({ balances: { A: 1, B: 1 }, bills: [{ id: "x", from: "A", to: "B", amount: 1.5, penalty: 1 }] }),
    /正整数/,
  );
  assert.throws(
    () => validateInput({ balances: { A: 1, B: 1 }, bills: [{ id: "x", from: "A", to: "B", amount: 1, penalty: -1 }] }),
    /非负整数/,
  );
  assert.throws(
    () => validateInput({ balances: { A: 1 }, bills: [{ id: "x", from: "A", to: "B", amount: 1, penalty: 1 }] }),
    /无初始余额/,
  );
  assert.throws(
    () =>
      validateInput({
        balances: { A: 1, B: 1 },
        bills: [
          { id: "x", from: "A", to: "B", amount: 1, penalty: 1 },
          { id: "x", from: "A", to: "B", amount: 1, penalty: 1 },
        ],
      }),
    /重复/,
  );
});

// ---------- 随机交叉验证 ----------

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

function randomInput(rand: () => number, n: number): ClearingInput {
  const accNames = ["A", "B", "C", "D"].slice(0, 2 + Math.floor(rand() * 3));
  const balances: Record<string, number> = {};
  for (const a of accNames) balances[a] = Math.floor(rand() * 21);
  const bills: Bill[] = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    from: accNames[Math.floor(rand() * accNames.length)]!,
    to: accNames[Math.floor(rand() * accNames.length)]!,
    amount: 1 + Math.floor(rand() * 15),
    penalty: Math.floor(rand() * 11),
  }));
  return { balances, bills };
}

test("随机小样本（n ≤ 8）：DP 与全排列穷举的最小罚费一致，证书自洽", () => {
  const rand = mulberry32(20261005);
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 8);
    const input = randomInput(rand, n);
    const { result } = run(input);
    const bf = solveBruteForce(input);
    assert.equal(
      result.minPenalty,
      bf.minPenalty,
      `iter=${iter} n=${n} 输入=${JSON.stringify(input)}`,
    );
    // 正向 DP 与逆推 DP 的可行子集完全一致
    const dp = computeDp(input);
    const reach = computeReachableForward(input);
    for (let s = 0; s < dp.model.size; s++) {
      assert.equal(dp.feasible[s], reach[s], `iter=${iter} 子集 ${s} 正逆推不一致`);
    }
  }
});

test("随机大样本（9 ≤ n ≤ 16）：正向/逆推 DP 一致，证书自洽", () => {
  const rand = mulberry32(777);
  for (let iter = 0; iter < 60; iter++) {
    const n = 9 + Math.floor(rand() * 8);
    const input = randomInput(rand, n);
    const { result } = run(input);
    const dp = computeDp(input);
    const reach = computeReachableForward(input);
    let reachBest = 0;
    for (let s = 0; s < dp.model.size; s++) {
      assert.equal(dp.feasible[s], reach[s], `iter=${iter} n=${n} 子集 ${s} 正逆推不一致`);
      if (reach[s] === 1 && dp.model.penSum[s]! > dp.model.penSum[reachBest]!) reachBest = s;
    }
    const totalPenalty = input.bills.reduce((sum, b) => sum + b.penalty, 0);
    assert.equal(result.minPenalty, totalPenalty - dp.model.penSum[reachBest]!);
  }
});

test("16 笔全额可付：罚费 0，全部 65536 个子集可行，合法序 16! 个", () => {
  const bills: Bill[] = Array.from({ length: 16 }, (_, i) => ({
    id: `b${i}`,
    from: "A",
    to: "B",
    amount: 1,
    penalty: i + 1,
  }));
  const { result } = run({ balances: { A: 16, B: 0 }, bills });
  assert.equal(result.minPenalty, 0);
  assert.equal(result.feasibleSubsetCount, 65536);
  let fact = 1n;
  for (let i = 2n; i <= 16n; i++) fact *= i;
  assert.equal(result.legalOrderCount, fact);
});
