# AGV 车队离线充电调度

Node.js 22、仅标准库、`node:test`。离线 AGV 车队在充电桩互斥、站点功率配额和
租户每日充电分钟上限下安排补能；支持紧急运输抢占、等待老化重排、乱序事件归并、
结算 cutoff、冲正证书与拒绝列表。

## 运行

```sh
node cli.js run examples/scenario.json          # 输出时间线/配额/冲正/拒绝
node cli.js run examples/settlement.json        # 结算 + 迟到事件场景
node cli.js enumerate examples/scenario.json    # <=6 事件全排列归并核对
node --test                                     # 运行全部测试
```

## 模型

- **配置**：`sitePowerKw`（站点功率配额）、`piles`（充电桩，各自功率）、
  `tenants`（每日充电分钟上限 `dailyMinutes`）、`vehicles`（所属租户、充电功率）。
- **事件**：`{ seq, ts, type, vehicleId, ... }`，`ts` 为业务时间戳（分钟），
  `seq` 为单调序列号。类型：`request`（申请充电 `minutes`，可带 `powerKw`）、
  `release`（释放/离开）、`emergency`（紧急运输，抢占充电位）。
- **调度规则**：一个充电桩同一时刻只服务一辆车；活跃会话功率之和不超过站点
  配额；租户每日充电分钟数不超过上限（超出部分截断，配额耗尽则等待）。
  紧急事件抢占最近开始的非紧急会话；被抢占车辆保留已充电量，以原始入队时间
  重新进入等待队列，等待队列按（优先级、入队时间、seq）老化排序派发。

## 乱序、结算与冲正

- 事件可乱序到达；每次接受事件后按 `(ts, seq)` 全量确定性重算，最终归并结果
  与到达顺序无关（`src/enumerate.js` 对 ≤6 个事件枚举全部到达顺序核对一致）。
- `settle(cutoffTs)` 结算：对 `end <= cutoff` 的会话生成租户账单。
- 业务时间在 cutoff 之前、**到达时间**不超过 cutoff 的迟到事件：接受并重算，
  若已定账单变化则生成冲正证书（`reversals`，含每租户 before/after/delta），
  并更新已定账单；重算始终保持租户配额、充电桩互斥与已完成记录一致。
- 到达时间超过 cutoff 的迟到事件：只登记到 `rejections`，已定结果不变。
- 校验错误（`errors`）：`duplicate-event`（重复 seq）、`unknown-vehicle`、
  `power-exceeded`（超额功率）、`invalid-minutes` 等，事件不入库。

## 输出

`report()` / CLI `run` 输出：

- `timeline`：充电会话（车辆、桩、起止、分钟、电量、结束原因
  `completed|preempted|released`）；
- `waiting`：仍在等待队列的车辆及剩余分钟；
- `quotas`：站点峰值功率/配额、各租户每日已用/上限/剩余分钟；
- `bills`：结算账单；`reversals`：冲正证书；`rejections`：拒绝列表；
  `errors`：校验错误。

## 文件

- `src/simulate.js`：纯函数仿真器（确定性重放）。
- `src/engine.js`：事件存储、校验、cutoff 结算、冲正证书。
- `src/enumerate.js`：≤6 事件全排列归并一致性核对。
- `src/scenario.js` / `cli.js`：场景执行与离线 CLI。
- `test/`：`node --test` 验收测试；`TEST-RESULTS.txt` 为真实执行记录。
