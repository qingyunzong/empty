# test-planner

测试规划 CLI：给定至多 **20 个有限策略** 与至多 **30 个候选样例**，选出**最少**的样例子集，
使所有*可区分*的策略对都被至少一个选中样例区分；对任何样例都无法区分的策略对，
输出**等价证据**。另用**独立的子集枚举**核对所选数量的最优性。

仅使用 TypeScript + Node.js 内置模块（`node:fs`、`node:test`、`node:assert` 等），无运行时依赖。

## 构建与测试

```sh
npm run build   # tsc -> dist/
npm test        # 构建并用 node:test 运行全部测试
npm run cli -- examples/demo.json        # 或: node dist/src/cli.js examples/demo.json
cat examples/demo.json | node dist/src/cli.js --stdin
```

## 输入格式

```json
{
  "samples":    [{ "id": "T1" }, { "id": "T2" }],
  "strategies": [{ "id": "S1", "outputs": [1, 2] },
                 { "id": "S2", "outputs": [1, 3] }]
}
```

- `samples`：1–30 个，`id` 为非空唯一字符串。
- `strategies`：1–20 个，`id` 唯一；`outputs[i]` 是该策略在 `samples[i]` 上的输出。
- 输出可以是任意 JSON 值（对象按键排序后做深比较）。

## 输出（JSON 报告）

- `selection.sampleIds`：选中的样例 ID，按字典序排列；`selection.count` 为最小数量。
- `equivalentPairs`：每个等价策略对及其证据（在所有候选样例上输出逐点相同，
  附 `sharedOutputs` 原文）。
- `verification`：独立子集枚举核对结果——`confirmed`（枚举得到的最小值与主求解器一致）、
  `inconclusive`（超出 `--verify-limit` 组合预算，退出码 2）或 `mismatch`。
- `summary`：策略/样例/策略对统计、无用样例（区分不了任何策略对）、
  可互换样例组（区分能力完全相同，选代表元时取最小 ID）。

退出码：`0` 已规划且核对通过；`1` 输入非法；`2` 核对未确认。

## 方法

1. **成对可区分性**：对每个策略对（≤ C(20,2)=190 对）计算能区分它的样例集合
   （30 位位掩码）；空集即等价对，输出证据。
2. **列约简**：区分能力（对位掩码）相同的样例折叠为一列，代表元取最小 ID；
   掩码为 0 的样例永不入选。
3. **精确最小集**（`src/solver.ts`）：迭代加深 DFS + 移位表剪枝，
   每次在未覆盖对中选分支最少者（MRV）展开，得到最小数量 k。
4. **代表元选择**：在大小为 k 的列组合中按字典序取第一组覆盖解，输出排序后的样例 ID。
5. **独立核对**（`src/verify.ts`）：与求解器不共享任何搜索代码——朴素枚举
   大小 0,1,2,… 的全部列子集，第一个覆盖全集的大小即枚举最小值，与 k 比对。

## 实际运行记录（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出摘要：

```
ok 1 - dist/test/cli.test.js
ok 2 - dist/test/solver.test.js
# tests 2
# pass 2
# fail 0
```

逐条测试（`node dist/test/<file>`，共 19 条，全部通过）：

```
solver.test.js (13/13 ok)
  ok selects the minimum samples distinguishing every pair
  ok reports equivalent strategies with identical-output evidence
  ok never selects samples that distinguish nothing
  ok collapses interchangeable samples and picks the smallest id
  ok returns an empty selection when every strategy is equivalent
  ok handles structured (nested) outputs via deep equality
  ok selected ids are sorted lexicographically
  ok exact solver matches independent enumeration on 300 random instances
  ok verifier flags a wrong claim as mismatch
  ok verifier reports inconclusive when the combination budget runs out
  ok enforces the 20-strategy and 30-sample limits
  ok accepts exactly 20 strategies and 30 samples
  ok rejects malformed input
cli.test.js (6/6 ok)
  ok cli plans the demo fixture end to end
  ok cli reads the problem from stdin with --stdin
  ok cli rejects input beyond the 20-strategy limit
  ok cli rejects invalid JSON and missing input
  ok cli exits with status 2 when verification is inconclusive
  ok cli prints usage with --help
```

`node dist/src/cli.js examples/demo.json` 实际输出要点（5 策略 / 5 样例，
D 与 E 等价，T4 无用，T1/T5 可互换）：

```json
{
  "selection": { "count": 2, "sampleIds": ["T1", "T2"] },
  "equivalentPairs": [
    { "strategies": ["D", "E"],
      "evidence": { "reason": "strategies \"D\" and \"E\" produce identical outputs on all 5 candidate samples; no sample can distinguish them",
                    "sharedOutputs": [2, 2, 1, 0, 2] } }
  ],
  "verification": { "method": "independent-subset-enumeration", "status": "confirmed",
                    "enumeratedMinimumSize": 2, "claimedSize": 2, "combinationsChecked": 5 }
}
```
