# agv-charge-scheduler

离线 AGV 车队充电调度库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- **充电桩互斥**：一个充电桩同一时刻只服务一辆车。
- **场站功率配额**：所有在充车辆功率之和不超过 `sitePowerKw`。
- **租户每日充电分钟上限**：充电段开始时预占租户配额分钟，提前结束（抢占/释放）时退还未用部分；配额耗尽的请求留在等待队列。
- **紧急抢占**：`priority: "emergency"` 的请求无法立即入位时，抢占剩余需求最大的非紧急在充车辆；被抢占车辆保留已充电量，携带原始 `waitSince` 回到等待队列。
- **等待老化**：同优先级内等待越久（`waitSince` 越小）越先调度；被抢占车辆因保留原始等待时间而优先于新到请求。
- **乱序事件**：事件携带业务时间戳 `ts` 与单调序列号 `seq`，归并顺序为 `(ts, seq, eventId)`，与到达顺序无关。时间 T 完成的充电先于 T 时刻的事件处理。
- **结算 cutoff**：`arrivalTs <= cutoffTs` 的迟到事件被接受并触发全量重算，账单变化生成冲正证书（`REV-n`，含车辆/租户级 before/after/delta）；`arrivalTs > cutoffTs` 的事件只登记拒绝（`after_cutoff`），已定账单不变。
- **拒绝**：`unknown_vehicle` / `duplicate_event`（eventId 或 vehicleId+seq 重复）/ `excess_power`（超过场站或最大充电桩功率）/ `unknown_tenant` / `invalid_shape` / `release_without_charge`。

## 使用

```bash
node cli.js run examples/scenario.json      # 输出时间线/配额/冲正/拒绝
node cli.js permute examples/scenario.json  # 枚举 <=6 事件的全部合法到达顺序并核对一致
```

库接口（`index.js`）：

- `simulate(events, config)` — 纯函数确定性仿真，返回 `{timeline, bills, quotas, rejections, unscheduled}`。
- `new Fleet(config)` — `ingest(event, arrivalTs)` 摄入事件，`report()` 输出 `{timeline, bills, quotas, unscheduled, reversals, rejections}`。
- `verifyOrderInvariance(config, events)` — 枚举全部到达排列（≤6 事件），验证最终时间线与账单一致。

场景文件格式见 `cli.js` 头部注释与 `examples/scenario.json`。

## 测试

```bash
node --test
```

覆盖：乱序申请/释放归并一致；紧急抢占与老化重排；cutoff 后迟到事件被拒且账单不变；超额功率/重复事件/未知车辆报错；功率配额、充电桩互斥、租户上限、账单与已完成记录一致性；≤6 事件全排列（720/120 种）归并一致。
