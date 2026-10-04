# 热处理车间离线炉批编排器

Node.js 22、仅标准库、`node:test`。每批带升温/保温/降温曲线，任意时刻总功率不超过峰值，
同炉温差与装炉量受限；输出时刻表或最小不可行证据。

## 运行

```bash
node --test     # 全部测试
node demo.js    # 演示：6 批编排 / UNSAT 证书 / 增量重排+undo / UNKNOWN
```

## 模型

- 批次 `{ id, alloy, band:[lo,hi], mass, curve, power }`
  - `curve: [{t, temp, phase?}]`：温度曲线，`t` 自 0 严格递增，分段线性插值；
    两端均标 `phase:'hold'` 的**保温段禁止负斜率**。
  - `power: [{t, power}]`：功率曲线，分段线性插值，末端之后常数外延；功率非负有限。
  - 批次占用炉次为半开区间 `[0, duration)`，`duration` 为温度曲线末时刻。
- 配置 `{ peak, capacity, deltaMax, grid=1, nodeLimit, maxSolutions, tol }`
  - 时间按 `grid` 离散，功率约束在格点上检验：任意时刻总功率 `<= peak`。
  - 同炉并批条件：同合金、温度带有公共交集、装炉量总和 `<= capacity`、
    任一曲线节点时刻同炉温差 `<= deltaMax`。
- 目标字典序：**完成时刻 makespan → 峰谷差 peakValley → 炉次数 runCount**。
  峰谷差为 `[0, makespan)` 内总功率包络的最大最小值之差。

## 求解机制（`src/solver.js`）

- 精确离散时间枚举：集合划分（受限增长串）× 炉次开炉时刻 DFS，
  带 makespan 上界剪枝与单炉次功率预剪枝。
- **并列最优全部保留**：`schedules` 返回所有达到最优字典序目标的方案
  （超过 `maxSolutions` 时 `tiesComplete=false`）。
- **UNSAT 证书**：按子集大小递增找到按包含关系极小的不可行子集，
  因此*删除子集中任意一批即可满足*；同时给出 `relaxPeakTo`——把峰值放宽到该值即满足。
- **UNKNOWN**：搜索或证书生成超出 `nodeLimit` 时单独返回 `status:'UNKNOWN'`，
  与 UNSAT 区分。
- 错误码：曲线时刻倒挂 / 负斜率保温段 → `ERR_CURVE`；功率 NaN、负功率、
  非法装炉量/温度带 → `ERR_DOMAIN`（`SchedulerError.code`）。

## 增量重排与撤销（`src/scheduler.js`）

`Scheduler` 维护批次集合与每批版本号；同炉兼容判定与子集可行性按
`id#version` 缓存，**编辑一批后仅含该批的子集缓存失效**，其余复用——
增量重排结果与全量重算严格一致（验收 3 验证）。`undo()` 从历史快照逐层恢复，
浮点精确到容差内（实际为结构化克隆的精确恢复）。

## API

```js
import { solve, Scheduler } from './src/index.js';

const res = solve(batches, { peak: 9, capacity: 5, deltaMax: 80 });
// res.status: 'OPTIMAL' | 'UNSAT' | 'UNKNOWN'
// OPTIMAL: res.objective {makespan, peakValley, runCount}, res.schedules [...]
// UNSAT:   res.certificate {subset, relaxPeakTo, deletionSuffices, message}

const sched = new Scheduler({ peak: 9, capacity: 5, deltaMax: 80 });
sched.addBatch(b); sched.editBatch('a3', { band: [870, 950] });
sched.resolve(); sched.undo();
```

## 验收覆盖（test/）

1. `验收1`：6 批求解结果与测试内**独立编写的离散时间枚举**对照（目标值与并列最优数量一致）。
2. `验收2`：峰值恰等于需求边界（9 == 4+5）可行；峰值 8.5 时退化为串行两炉次。
3. `验收3`：改温度带后增量重排与全量重算一致；`undo` 恢复到浮点容差内。
4. `验收4`：曲线时间倒挂 → `ERR_CURVE`；功率 NaN → `ERR_DOMAIN`；负斜率保温段 → `ERR_CURVE`。
5. `test/solver.test.js`：UNSAT 证书（删一批/放宽峰值即满足）、并列最优保留、
   节点预算耗尽 → `UNKNOWN`、空批次、超装炉量证书。

## 真实输出

`node --test`（2 个文件、9 个用例全部通过）：

```
ok 1 - test/acceptance.test.js
ok 2 - test/solver.test.js
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2708.335425
```

`node demo.js`：

```
=== 1) 6 批离线编排 (peak=9, capacity=5, deltaMax=80) ===
status=OPTIMAL objective={"makespan":8,"peakValley":4,"runCount":5} ties=11 tiesComplete=true nodes=11244
  方案1: 炉次[a1] t=0..3 | 炉次[a2] t=0..3 | 炉次[a3] t=2..5 | 炉次[b1] t=3..6 | 炉次[b2+b3] t=5..8
  方案2: 炉次[a1] t=0..3 | 炉次[a2] t=0..3 | 炉次[b1] t=2..5 | 炉次[a3] t=3..6 | 炉次[b2+b3] t=5..8
  方案3: 炉次[a1] t=0..3 | 炉次[b1] t=0..3 | 炉次[a2] t=2..5 | 炉次[a3] t=3..6 | 炉次[b2+b3] t=5..8
  方案4: 炉次[a1] t=0..3 | 炉次[a3] t=1..4 | 炉次[b1] t=2..5 | 炉次[a2] t=3..6 | 炉次[b2+b3] t=5..8
  方案5: 炉次[a1] t=0..3 | 炉次[b1] t=0..3 | 炉次[a3] t=2..5 | 炉次[a2] t=3..6 | 炉次[b2+b3] t=5..8
  方案6: 炉次[a2] t=0..3 | 炉次[a3] t=0..3 | 炉次[a1] t=2..5 | 炉次[b1] t=3..6 | 炉次[b2+b3] t=5..8
  方案7: 炉次[a2] t=0..3 | 炉次[b1] t=0..3 | 炉次[a1] t=2..5 | 炉次[a3] t=3..6 | 炉次[b2+b3] t=5..8
  方案8: 炉次[a3] t=0..3 | 炉次[b1] t=0..3 | 炉次[a1] t=2..5 | 炉次[a2] t=3..6 | 炉次[b2+b3] t=5..8
  方案9: 炉次[a2] t=0..3 | 炉次[a3] t=0..3 | 炉次[b1] t=2..5 | 炉次[a1] t=3..6 | 炉次[b2+b3] t=5..8
  方案10: 炉次[a2] t=0..3 | 炉次[b1] t=0..3 | 炉次[a3] t=2..5 | 炉次[a1] t=3..6 | 炉次[b2+b3] t=5..8
  方案11: 炉次[a3] t=0..3 | 炉次[b1] t=0..3 | 炉次[a2] t=2..5 | 炉次[a1] t=3..6 | 炉次[b2+b3] t=5..8

=== 2) UNSAT 证书（bad 单批功率 10 > peak 9）===
status=UNSAT
certificate={"subset":["bad"],"relaxPeakTo":10,"deletionSuffices":true,"message":"子集 {bad} 不可行：删除其中任意一批即可满足；或将峰值放宽至 10"}

=== 3) 增量重排与撤销 ===
初始: makespan=6 runs=4
改 a3 温度带 -> [870,950] 后(增量): makespan=6 runs=4
全量重算对照: makespan=6 runs=4 一致=true
undo 后: makespan=6 runs=4 与初始一致=true

=== 4) UNKNOWN（节点预算=3）===
status=UNKNOWN reason=搜索超出节点预算 3
```
