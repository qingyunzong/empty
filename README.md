# test-planner

测试规划 CLI：给定至多 **20 个有限策略** 和至多 **30 个候选样例**，每个策略在每个样例上产生一个输出；
选出**最少**的样例子集，使得所有*可区分*的策略对都能被该子集区分（至少一个选中样例上输出不同）。
对在全部候选样例上输出完全一致的策略对，输出**等价证据**（等价类 + 全样例一致输出向量）。
答案按**样例 ID 字典序**输出最小解，并用**独立子集枚举**核对最优性。

仅使用 TypeScript + Node.js 内置库，零运行时依赖。

## 使用

```sh
npm run build                              # 全局 tsc 编译到 dist/
node dist/src/cli.js plan <input.json|->   # '-' 表示从 stdin 读取
node dist/src/cli.js plan fixtures/demo.json --no-verify
node dist/src/cli.js plan fixtures/demo.json --verify-budget 5000000
```

输入 JSON：

```json
{
  "samples": ["s1", "s2", "s3"],
  "strategies": [
    { "id": "A", "outputs": [0, 1, 1] },
    { "id": "B", "outputs": { "s1": 0, "s2": 1, "s3": 0 } }
  ]
}
```

- `samples`：1..30 个唯一样例 ID。
- `strategies`：1..20 个策略；`outputs` 可以是与 `samples` 对齐的数组，或以样例 ID 为键的对象，必须覆盖每个样例。输出值可以是任意 JSON（对象按键排序后做结构比较）。

输出 JSON（节选）：

- `minimumSamples` / `selectedSamples`：最少样例数与按 ID 排序的选取结果（多个最优解中取 ID 字典序最小者）。
- `equivalenceClasses`：无法区分的策略等价类，`evidence.identicalOutputs` 给出全样例一致输出作为等价证据。
- `verification`：独立枚举核对结果（见下）。

## 算法

1. **可区分结构**（`src/solver.ts`）：对每对策略计算能区分它的样例集合；空集即为等价对（并入等价类）。
   每个样例对应它所能区分的策略对集合（BigInt 位掩码，190 对以内）。选最少样例覆盖全部可区分对，
   即最小 hitting set。
2. **精确求解**：分支定界（装箱下界 + 最小候选集对优先分支 + 记忆化），再用带后缀剪枝的组合枚举
   取出 ID 字典序最小的最优子集，保证输出确定。
3. **独立核对**（`src/verify.ts`）：另一条代码路径，按规模 0..k-1 字典序枚举全部样例子集
   （仅以"剩余样例仍可补全覆盖"这一必要条件剪枝），确认不存在更小的可行子集；
   同时枚举规模 k 统计最优解个数 `optimalSolutionCount`。`--verify-budget` 限制枚举节点数，
   超限时如实报告 `budgetExhausted` 而不是假装确认。

## 测试

```sh
npm test    # tsc 构建 + node --test
```

- `test/model.test.ts`：输入校验（20/30 上限、重复 ID、缺失/多余输出、结构比较）。
- `test/solver.test.ts`：60 个随机用例上与 2^m 暴力枚举对照最小规模与字典序选取。
- `test/verify.test.ts`：枚举核对与暴力计数一致；错误最优值能给出反例；预算耗尽如实上报。
- `test/plan.test.ts`：demo fixture 对照手工推导结果（最优 7、选取 s01-s04+s06-s08、192 个最优解、等价类 P19/P20）。
- `test/cli.test.ts`：CLI 参数、退出码、stdin、以及真实子进程端到端运行。

`fixtures/demo.json` 由 `scripts/generate-demo.js` 生成（20 策略 × 30 样例：9 个 one-hot 探针 +
4 个复制品 + 17 个常量噪声样例；P19/P20 完全等价），其最优解可手工推导，用于独立校验工具输出。

## 实际运行结果（2026-10-05，Node v22.22.1）

`npm test`：

```
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
# Subtest: dist/test/model.test.js
ok 2 - dist/test/model.test.js
# Subtest: dist/test/plan.test.js
ok 3 - dist/test/plan.test.js
# Subtest: dist/test/solver.test.js
ok 4 - dist/test/solver.test.js
# Subtest: dist/test/verify.test.js
ok 5 - dist/test/verify.test.js
# tests 5
# pass 5
# fail 0
# duration_ms 771.985326
```

`node dist/src/cli.js plan fixtures/demo.json`：

```
minimumSamples: 7
selectedSamples: s01,s02,s03,s04,s06,s07,s08
pairs: total=190 distinguishable=189 equivalent=1
equivalenceClasses: [{ strategies: [P19, P20], evidence: identical outputs on all 30 samples }]
verification: confirmed=true, optimalSolutionCount=192, nodesVisited=16357
elapsedMs: ~21
```

与手工推导一致：5 个组探针取 4 个（16 种）× 4 个变体探针取 3 个（12 种）= 192 个最优子集，
字典序最小为 s01..s04 + s06..s08。
