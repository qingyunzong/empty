# billing-core

区间计费、费用清算与冲正台账。TypeScript 编写，运行时与测试仅使用 Node.js
内置库（`node:test`、`node:assert`），零 npm 依赖。

## 模型

- **区间**：半开区间 `[start, end)`，整数秒。
- **分段计费**（`src/billing.ts`）：上线区间先求并集（重叠或首尾相接即合并，
  `mergeIntervals`），再与费率区间逐段求交；每段秒数向上计分钟
  `ceil(seconds/60)` 乘费率（分/分钟）。每段记录来源：合并后上线区间下标
  `sourceOnlineIndex` 与费率区间下标 `sourceRateIndex`。
- **网格对照**（`billByGrid` / `compareWithGrid`）：时间轴按 60 秒网格切分，
  上线时间碰到的每个网格计 1 分钟，作为分段模型的独立对照；差异按
  `diffCents = 分段合计 − 网格合计` 报告。
- **分账**（`src/settlement.ts`）：每段费用按用户占用秒比例分摊，每户向下
  取分；剩余分按“精确余数降序、用户 ID 升序”逐个分配。精确值用 BigInt
  计算（`exactNumerator / totalSeconds`），无浮点误差。逐段守恒
  （Σ分账 = 段费用）蕴含全账守恒（Σ = 总费用），`settleAccount` 两处均校验。
- **台账**（`src/ledger.ts`）：仅追加。条目 ID 为幂等键——同 ID 同内容重复
  追加被忽略，同 ID 不同内容报错。`publish()` 后条目不可变；历史更正用
  `reverse()` 发冲正账（金额为负、引用原条目），不修改已发布账。
- **引擎**（`src/engine.ts`）：`BillingEngine.applyRun` 完成
  计费→分账→入账，条目 ID 由 `(runId, 段号, userId)` 确定性生成，因此
  断点重放（崩溃恢复后重放同一批 run）幂等，结果与一次性跑完逐字节一致。
  `correctRun(oldRunId, newRun)` 对旧 run 全部已发布账发冲正并入新账。

## 使用

```bash
npm test   # tsc 编译 + node --test
```

```ts
import { BillingEngine, Ledger } from "./src/index.js";

const ledger = new Ledger();
const engine = new BillingEngine(ledger);
const result = engine.applyRun({
  runId: "run-1",
  accountId: "acct-1",
  online: [{ start: 0, end: 100 }, { start: 50, end: 150 }], // 并集成 [0,150)
  rates: [{ start: 0, end: 1000, ratePerMinuteCents: 10 }],
  users: [
    { userId: "alice", online: [{ start: 0, end: 60 }] },
    { userId: "bob", online: [{ start: 40, end: 150 }] },
  ],
});
ledger.publish();
// 历史更正：冲正 run-1 全部已发布账，按新 run 重新入账
engine.correctRun("run-1", { runId: "run-2", /* ... */ });
```

## 测试结果（实际运行记录）

环境：Node.js v22.22.1，TypeScript 7.0.2。命令：`npm test`
（`tsc -p tsconfig.json && node --test "dist/test/*.test.js"`）。

```
# tests 4  (4 个测试文件，共 21 个用例)
# pass 4
# fail 0
```

逐文件明细（`node dist/test/<file>` 直接运行的 TAP 输出）：

```
== billing.test.js   6/6 pass
ok 1 - 分段计费：并集后与费率求交，每段向上计分钟乘费率
ok 2 - 来源段：记录合并后上线区间与费率区间下标
ok 3 - ceil/grid 基本性质
ok 4 - 网格对照：网格对齐时两模型一致
ok 5 - 网格对照：错位时分段模型可能多计，差异被报告
ok 6 - 费率区间重叠被拒绝

== intervals.test.js  5/5 pass
ok 1 - 并集：重叠、包含、相邻区间合并
ok 2 - 并集：不相交区间保持分离且有序
ok 3 - 并集：空输入与零长区间
ok 4 - 求交：半开区间边界
ok 5 - 非法区间报错

== ledger.test.js   5/5 pass
ok 1 - 入账：分段计费后按占用秒比例分账，逐段与全账守恒
ok 2 - 幂等：重复追加同 ID 同内容被忽略，内容冲突报错
ok 3 - 历史更正：发冲正账，已发布账不被修改
ok 4 - 断点重放幂等：崩溃后重放与一次性跑完结果一致
ok 5 - 重放更正流程同样幂等

== settlement.test.js   5/5 pass
ok 1 - 按比例分账：向下取分后余分按精确余数分配
ok 2 - 余分按精确余数降序，余数大的优先
ok 3 - 边界：零费用、零占用、非法输入
ok 4 - 全账清算：逐段守恒且全账守恒
ok 5 - 小分账枚举核对：穷举小额费用与占用，验证守恒与分配规则
```

小分账枚举核对规模：费用 0..47 分 × 1..4 用户 × 每户 0..5 秒（总占用 > 0），
共 74,400 例，逐例核对守恒、份额 ∈ {⌊精确值⌋, ⌊精确值⌋+1}、余分分配顺序。
