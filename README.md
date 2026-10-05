# shift-timekeeper

员工班次区间计时库。TypeScript 编写，仅使用 Node.js 内置模块（`node:test` /
`node:assert`），零 npm 运行时依赖。

## 模型一：区间归属（`src/attribute.ts`）

按员工班次区间计算工时：

- 重叠时间只计一次，归优先级高的班次；优先级相同则开始时间早者优先，再相同则
  ID 小者优先（`compareShiftPrecedence`）。
- 休息区间先扣除，休息时间内的时间不归属任何班次。
- 输出归属分段（`segments`）、每班次秒数（`totals`）与总秒数（`totalSeconds`）。

两个独立实现互相核对：

- `attributeWork`：按优先级顺序做区间差集（先减休息，再减更高优先级班次已占区间）。
- `attributeWorkSweep`：端点扫描参考模型——收集全部端点，逐基本区间判定归属后合并。

```ts
import { attributeWork } from './src/attribute.js';

const result = attributeWork(
  [
    { id: 1, start: 0, end: 10, priority: 1 },
    { id: 2, start: 5, end: 15, priority: 2 },
  ],
  [{ start: 3, end: 4 }],
);
// result.segments => 归属分段；result.totalSeconds => 总秒数
```

## 模型二：联合分配（`src/allocate.ts`）

在模型一基础上新增每班次约束，不能逐点贪心选择，需在全部区间上联合分配：

- 每班次 `maxWork`：最大归属工时（秒）；`minRest`：最低休息（秒），
  有效上限为 `min(maxWork, 班次时长 - minRest)`。
- 约束：最多 12 个班次，整数端点 0 至 30（每秒一个槽位，共 30 槽）。
- 目标（字典序）：先合法覆盖（总归属秒数）最多，再优先级收益
  `Σ 归属秒数 × priority` 最大。
- 输出归属分段与休息证书（每班次 `worked` / `rest`，可校验
  `worked <= maxWork` 且 `rest >= minRest`）。

求解器 `allocate` 使用最小费用最大流（源→槽位→班次→汇，班次→汇容量为有效上限、
费用为 `-priority`，SPFA 逐最短路增广），整数容量保证整数最优解，结果确定。
`exhaustiveAllocate` 对每个槽位穷举「归属某班次 / 休息」，用于小规模核对。

```ts
import { allocate } from './src/allocate.js';

const result = allocate([
  { id: 1, start: 0, end: 2, priority: 10, maxWork: 1, minRest: 0 },
  { id: 2, start: 0, end: 1, priority: 1, maxWork: 1, minRest: 0 },
]);
// 逐点贪心会把槽 0 给班次 1 导致槽 1 无人可覆盖（覆盖 1）；
// 联合分配得槽 0→班次 2、槽 1→班次 1，覆盖 2，收益 11。
```

## 运行

前提：Node.js（本仓库在 v22.22.1 验证）与 `tsc`（TypeScript 编译器）。
本环境的 Node 未内建类型擦除支持，故 `npm test` 先编译到 `dist/` 再执行。

```sh
npm test        # tsc && node --test dist/test/*.test.js
npm run typecheck
```

## 实测结果（2026-10-06，Node v22.22.1）

`npm test`：2 个测试文件全部通过（pass 2 / fail 0，约 1.0s）。逐用例明细：

```
ok 1 - fixed example: priority, tie-breaks and rest deduction
ok 2 - tie-break: same priority and start falls back to smaller id
ok 3 - tie-break: same priority prefers earlier start
ok 4 - rest fully covering a shift yields zero seconds
ok 5 - empty input yields empty result
ok 6 - invalid input is rejected
ok 7 - randomized: interval-difference model matches endpoint-sweep reference
# tests 7 / pass 7 / fail 0   (attribute)

ok 1 - joint allocation beats pointwise greedy
ok 2 - equal coverage prefers higher priority benefit
ok 3 - minRest caps attribution even when maxWork allows more
ok 4 - maxWork caps attribution and overflow goes to lower priority shift
ok 5 - validation rejects out-of-contract input
ok 6 - randomized: solver matches exhaustive search (coverage, benefit)
ok 7 - randomized: full-size instances stay legal and deterministic
ok 8 - medium-size instances still match exhaustive search
# tests 8 / pass 8 / fail 0   (allocate)
```

核对规模：

- 模型一：1000 组随机实例，区间差集实现与端点扫描参考模型逐一深度一致。
- 模型二：400 组小规模（≤3 班次、跨度 ≤7）+ 30 组中规模（4 班次、跨度 ≤10）
  随机实例，求解器的 `(coverage, benefit)` 与穷举最优完全一致；
  50 组满规模（12 班次、端点 0–30）实例校验休息证书合法性与结果确定性。
