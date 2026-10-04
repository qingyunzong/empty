# 热处理车间炉批离线编排 (furnace-batch-scheduler)

Node.js 22、仅标准库、`node:test`。无第三方依赖。

## 模型

- **批次 (batch)**：`{ id, alloy, tempBand: [lo, hi], load, curve }`。
- **曲线 (curve)**：点列 `{ t, temp, phase, power }`，`t` 从 0 严格递增；
  温度与功率在点间**线性插值**，曲线结束后功率为 0。
  `phase ∈ heat|hold|cool` 标记从该点出发的分段；**保温段禁止负斜率**。
- **炉次 (run)**：同时开炉的一批兼容批次。兼容条件：
  合金同组（`alloyGroups`）、温度带交集非空、装炉量之和 `≤ capacity`、
  任意时刻同炉温差 `≤ maxTempDiff`。
- **全局约束**：任意时刻所有并行炉次总功率 `≤ peakLimit`（含边界，容差 1e-9）。
- **时间离散化**：开炉时刻取整数时刻；曲线值按插值连续求值，
  功率极值在全部断点（开炉/结束/曲线拐点）的左右极限上精确取到。
- **目标（字典序）**：完成时刻 makespan → 峰谷差（[0, makespan) 内总功率 max−min）→ 炉次数。
  搜索保留**全部并列最优**时刻表（上限 `maxTies`，超出置 `tiesTruncated`）。

## 求解与状态

`solveSchedule(batches, config, opts)` 返回：

- `OPTIMAL`：`{ objective: {makespan, peakValley, runs}, schedules: [...] }`，`schedules` 为全部并列最优。
- `UNSAT`：`certificate` 给出子集极小的不可行核 `{ subset, removal, relaxedPeak }`：
  核中**删去任意一批**即恢复可行（`removal[id] === 'FEASIBLE'`）；
  或把峰值放宽到 `relaxedPeak` 即满足（装炉量超限导致时为 `null`，表示放宽峰值无效）。
- `UNKNOWN`：节点预算 `opts.nodeBudget` 耗尽，与 UNSAT 单独区分，附 `incumbent`（未证明最优）。
- `ERROR`：`errors` 含 `ERR_CURVE`（时间倒挂、非 0 起点、保温段负斜率、缺 phase）
  或 `ERR_DOMAIN`（功率 NaN/负值、装炉量/温度带/配置非法）。

精确性说明：可行性判定利用“顺序排布的峰值不超过最大炉次峰值”，
故 UNSAT 判定是精确完备的；优化阶段为分支定界（划分枚举 × 整数开炉时刻 DFS，
贪心完工上界 + 跨划分共享上界剪枝）。

## 增量重排与撤销

```js
import { Scheduler } from './src/index.js';
const sched = new Scheduler(config);
sched.setBatches(batches);        // 全量求解
sched.editBatch('b3', { tempBand: [885, 905] }); // 增量重排
sched.undo();                     // 精确恢复（深拷贝快照，浮点零误差）
```

增量机制：炉次可行性 / 功率剖面按“块内批次定义哈希 + 配置哈希”缓存，
编辑一批仅使含该批的块失效；结果与全量重解逐项一致（验收 3 验证）。

## 运行测试

```sh
node --test
```

真实输出（Node v22.22.1）：

```
TAP version 13
# Subtest: test/acceptance.test.js
ok 1 - test/acceptance.test.js
  ---
  duration_ms: 10737.37363
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10944.559766
```

子测试明细（`node test/acceptance.test.js`）：

```
ok 1 - acceptance 1: 6 batches match discrete-time enumeration
ok 2 - acceptance 2: peak exactly equal to demand boundary is feasible
ok 3 - acceptance 3: temp-band edit -> incremental == full re-solve, undo restores
ok 4 - acceptance 4: curve time inversion -> ERR_CURVE, NaN power -> ERR_DOMAIN
ok 5 - UNSAT certificate: remove-one or relaxed-peak subset
ok 6 - UNKNOWN is reported separately when the node budget is exhausted
ok 7 - tied optima are all preserved
```

## 文件

- `src/curve.js` — 曲线校验（ERR_CURVE/ERR_DOMAIN）与线性插值
- `src/model.js` — 并炉兼容性、炉次功率剖面、总功率左右极限与统计
- `src/solver.js` — 分支定界求解、UNSAT 证书、UNKNOWN 预算
- `src/scheduler.js` — 增量重排 + 撤销
- `src/brute.js` — 独立离散时间枚举器（验收 1 对照用）
- `test/acceptance.test.js` — 4 项验收 + UNSAT/UNKNOWN/并列最优
