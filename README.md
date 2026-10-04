# bench-ab-analysis

A/B 基准耗时配对分析库。TypeScript 编写，运行时仅使用 Node.js 内置库
（`node:fs` / `node:path` / `node:os` / `node:test` / `node:assert`），零运行时依赖。

## 功能

- **配对**：样本按 `(env, inputDigest, round)` 配对 A/B 两侧整数耗时；
  缺样本的一侧列保持为空（`null`），绝不填 0，也不参与统计。
- **配对差统计**：对完整配对差 `A - B` 给出精确中位数（偶数个取中间两值均值）。
- **Wilcoxon 有符号秩和检验**：
  - 丢弃零差（仍计入中位数）；
  - 绝对值并列取平均秩（如 1.5、2.5）；
  - 统计量 `T = |W+ − W−|`；
  - 精确双侧 p = 全部 `2^n` 种符号重排中 `|W+* − W−*| ≥ T` 的比例，
    计数用整数 DP（秩放大 2 倍避免分数）穷举，结果精确。
- **输出**：报告使用样本 ID，并给出穷举证据
  （`extremeCount / totalReassignments` 及每对样本的差与秩）。
- **冲突拒绝**：同一 `(env, digest, round, arm)` 重复提交、重复样本 ID、
  非整数耗时/轮号均被拒绝，且失败提交不产生任何状态变化（原子性）。
- **补交 / 撤回**：`submit` / `withdraw` 原子地维护配对与秩——先在内存副本上
  完成计算并写入快照（临时文件 + rename），成功后才切换当前状态。
- **持久快照**：每次接受的变更生成 `snapshot-NNNNNN.json`，旧快照永不覆盖，
  旧分析可随时通过 `store.snapshot(version)` 读取；重新打开目录时从最新快照恢复。
- **独立全重排核对**：`verify()` 从原始样本出发对全组独立重算秩，
  与增量维护的结果不一致时更正并记录快照，返回更正报告。

## API 摘要

```ts
import { BenchmarkStore, formatReport } from "bench-ab-analysis";

const store = BenchmarkStore.open("./data");
store.submit({ id: "a0", env: "linux-x64", inputDigest: "sha256:abc",
               round: 0, arm: "A", durationMs: 120 });
store.submit({ id: "b0", env: "linux-x64", inputDigest: "sha256:abc",
               round: 0, arm: "B", durationMs: 100 });
store.withdraw("b0");
console.log(formatReport(store.analyze()));
const report = store.verify(); // 独立全重排核对
```

## 测试

```
npm test    # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
> bench-ab-analysis@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/stats.test.js
ok 1 - dist/test/stats.test.js
# Subtest: dist/test/store.test.js
ok 2 - dist/test/store.test.js
1..2
# tests 2
# pass 2
# fail 0
# duration_ms ~230
```

覆盖：精确中位数（奇/偶）、并列平均秩、零差丢弃、Wilcoxon 精确双侧 p
（含与暴力枚举 `2^5` 重排交叉验证）、配对/缺样本空列、重复轮冲突拒绝、
原子补交与撤回、快照保留旧分析、重开恢复、`verify()` 全重排更正、
报告空列不填 0。

## 目录结构

- `src/types.ts` — 样本、配对、分析与快照类型
- `src/stats.ts` — 精确中位数、平均秩、Wilcoxon 精确检验（整数 DP 穷举）
- `src/analysis.ts` — 由配对与样本计算分组分析
- `src/store.ts` — `BenchmarkStore`：原子提交/撤回、快照持久化、`verify()`
- `src/report.ts` — 文本报告（缺样本列留空）
- `test/` — `node:test` 测试
- `types/node-shims.d.ts` — 本地最小 Node 内置模块类型声明（环境无网络，
  无法安装 `@types/node`；仅编译期使用，运行时无任何外部依赖）
