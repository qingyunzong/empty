# shift-time-allocator

员工班次工时归属库。TypeScript 编写，运行时仅使用 Node.js 内置模块（零依赖）。

## 模型

- 时间轴为整数端点 `0..30`（共 30 个单位秒槽 `[t, t+1)`），最多 12 个班次。
- 每个班次：`id`、`priority`（大者优先）、`work` 工作区间、`rest` 休息区间（先扣除）、
  可选 `maxWork`（最大归属工时）、`minRest`（最低休息）。
- 休息区间裁剪到工作区间内；工作区间减去休息区间后才是可归属槽位。

## 第一部分：基础归属（`attributeSweep` / `attributeReference`）

重叠区间只计一次，归属优先级最高的班次；优先级相同取开始更早者，再相同取 id 更小者。
休息区间先从各班次扣除。输出合并后的归属分段、每班次总秒数与总秒数。

- `attributeSweep`：端点扫描线实现，只在区间端点处切分。
- `attributeReference`：逐点参考模型，用于交叉核对（fuzz 1000 例逐段比对）。

## 第二部分：联合分配（`allocate`）

在每班次 `maxWork` 上限与 `minRest` 下限约束下做**全区间联合分配**
（不是逐点贪心：逐点贪心会把高优先级班次占满在可被低优先级覆盖的槽位上，降低总覆盖，
见测试 "joint allocation covers more than point-wise greedy"）。

- 每班次有效容量 `cap = min(maxWork, 可归属槽数 - max(0, minRest - 显式休息秒数))`。
- 目标字典序：先合法覆盖秒数最多，再优先级收益（归属秒数 × 班次优先级之和）最大。
- 精确解法：最小费用最大流（源→槽位→班次→汇），先最大流保证覆盖，
  同流量下最小费用等价于最大收益。
- 输出：归属分段、每班次总量、覆盖秒数、收益，以及每班次**休息证书**
  （显式休息区间 + 未归属槽位折算的休息区间、休息秒数、是否满足 `minRest`）。
- `verifyAllocation`：独立校验器，检查分段合法、互不重叠、容量与最低休息约束。
- `exhaustiveOptimum`：穷举搜索（分支限界 + 记忆化）作为核对基准，
  fuzz 中与 MCMF 结果逐一比对覆盖与收益。

## 使用

```ts
import { attributeSweep, allocate } from "./src/index";

const basic = attributeSweep([
  { id: 1, priority: 5, work: [{ start: 0, end: 10 }], rest: [{ start: 2, end: 4 }] },
  { id: 2, priority: 7, work: [{ start: 8, end: 20 }] },
]);
// basic.segments = [{shiftId:1,0,2},{shiftId:1,4,8},{shiftId:2,8,20}], totalSeconds = 18

const plan = allocate([
  { id: 1, priority: 9, work: [{ start: 0, end: 2 }], maxWork: 1 },
  { id: 2, priority: 1, work: [{ start: 0, end: 1 }] },
]);
// plan.coverage = 2, plan.benefit = 10（逐点贪心只能覆盖 1 秒）
```

## 测试

```sh
npm test   # tsc 编译到 dist/ 后用 node --test 运行
```

需要全局可用的 `tsc`（构建工具）；运行时无任何第三方依赖。

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出摘要：

```
# tests 2
# pass 2
# fail 0
# duration_ms ~1900
```

全部 17 个用例通过：

```
basic.test.js
ok 1 - overlap counted once, priority then earlier start then smaller id, rest deducted first
ok 2 - equal priority: earlier start wins over smaller id
ok 3 - equal priority and equal start: smaller id wins
ok 4 - rest interval of the only shift leaves a gap
ok 5 - rest outside work is ignored; overlapping work intervals merge
ok 6 - empty input yields empty attribution
ok 7 - endpoint sweep matches point-wise reference model (fuzz)          # 1000 随机例
ok 8 - validation rejects bad input

allocate.test.js
ok 1 - joint allocation covers more than point-wise greedy               # 联合分配优于逐点贪心
ok 2 - maxWork caps attributed seconds
ok 3 - minRest forces unassigned rest inside work span
ok 4 - explicit rest counts toward minRest certificate
ok 5 - among maximal coverage, priority benefit is maximized
ok 6 - unconstrained allocation matches basic attribution coverage       # 200 随机例
ok 7 - allocation matches exhaustive search (fuzz)                       # 300 随机例，0 跳过
ok 8 - allocation matches exhaustive search at the 12-shift limit        # 25 随机例（12 班次）
ok 9 - exhaustive search confirms the greedy-gap instance
```
