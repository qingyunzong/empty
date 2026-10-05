# benchpair

基准分析库：按 **环境 (env) + 输入摘要 (input) + 轮号 (round)** 配对 A/B 整数耗时样本，
对配对差给出精确中位数与 Wilcoxon 有符号秩精确双侧检验。仅使用 TypeScript 与 Node.js 内置库。

## 规则

- **配对**：同一 `(env, input, round)` 下 A、B 两侧齐全才成对，差值 = `A.durationMs - B.durationMs`。
- **缺样本不填 0**：只有单侧的轮次列入 `unpaired`（保留样本 ID 与真实耗时），不参与差值、中位数与秩检验。
- **重复轮冲突拒绝**：同一 `(env, input, round, side)` 或相同样本 ID 再次提交抛
  `DuplicateRoundError` / `DuplicateSampleError`，状态保持不变。
- **Wilcoxon 有符号秩**：丢弃零差；按绝对值排序，并列取平均秩；观测统计量 `W = |T+ − T−|`；
  精确双侧 p = 全部 `2^n` 种符号重排中 `|T+* − T−*| ≥ W` 的比例（含观测自身）。
  非零差超过 25 个时拒绝计算（精确穷举不可行）。
- **穷举证据**：输出携带样本 ID（`entries[].aId/bId`）、每对秩与符号、
  `permutations`（重排总数）、`extremeCount`（达到观测值的重排数）与 `pValue`。
- **原子维护**：`submit` / `withdraw` 先校验后一次性更新样本表、配对索引并生成新快照，
  拒绝时不留部分状态。
- **持久快照**：每次变更追加不可变 `Snapshot`（`submit` / `withdraw` / `audit-correction`），
  旧分析通过 `snapshots()` / `getSnapshot(seq)` 原样保留。
- **独立全重排核对**：`auditRanks()` 用独立的计数式秩算法对全量样本重新分组重排，
  与最新快照逐组比对；发现整组秩漂移时以重排结果生成 `audit-correction` 快照更正，
  并在报告中列出更正前后的秩。

## 使用

```ts
import { BenchmarkStore } from './src/benchmark.js';

const store = new BenchmarkStore();
store.submit({ id: 'a-r0', env: 'linux-x64', input: 'sha256-1MiB', round: 0, side: 'A', durationMs: 120 });
store.submit({ id: 'b-r0', env: 'linux-x64', input: 'sha256-1MiB', round: 0, side: 'B', durationMs: 100 });
const analysis = store.latest()!.groups[0];
// analysis.pairs[0].diff === 20, analysis.medianDiff === 20
```

## 构建与测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 退出码 0。测试文件直接运行的 TAP 输出：

```
ok 1 - exactMedian: odd, even, empty
ok 2 - averageRanks: ties share the average rank
ok 3 - independent counting ranker agrees with sort-based ranker (seeded fuzz)
ok 4 - wilcoxon exact: diffs [1,2,3] gives p = 2/8
ok 5 - wilcoxon exact: tied absolute values use average ranks, p = 6/8
ok 6 - wilcoxon exact: zero diffs are dropped before ranking
ok 7 - pairing by env/input/round; missing side stays unpaired, never zero-filled
ok 8 - late submission completes the pair atomically; old snapshot is retained
ok 9 - duplicate round conflict is rejected and leaves state untouched
ok 10 - duplicate sample id and invalid durations are rejected
ok 11 - withdrawal atomically breaks the pair; earlier snapshots keep old analysis
ok 12 - groups are split by env and input, sorted deterministically
ok 13 - evidence: sample ids, exhaustive permutation counts, exact median
ok 14 - zero-diff rounds are reported as dropped, not ranked
ok 15 - audit on a healthy store finds no corrections
ok 16 - audit corrects whole-group rank drift via independent re-ranking
# tests 16
# pass 16
# fail 0
```
