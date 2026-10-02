# curing-furnace-planner

离线固化炉批量排产库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 模型

- **炉次（run）**：一炉可混装同一 `family` 的多个配方，总装载量 ≤ `config.capacity`，
  加工时长 `config.runDuration`。相邻炉次 family 切换产生 `config.cleanoutTime` 清炉时间。
- **配方（recipe）**：`family` 决定兼容性；`dailyQuota` 为每日配额（按炉次开始日统计，
  日长 `config.dayLength`），硬约束，超出则顺延到下一日。
- **工单（order）**：`qty`、`due`、`priority`（`normal`/`urgent`）、`arrival`、
  `splittable`（默认可拆分到多炉）、`toolingPrepared`（专用工装已准备）、
  `group`（同组工单必须同炉，不兼容或超容量则整体失败）。
- **紧急抢占**：滚动更新时紧急工单在下一个批次边界（冻结炉次结束之后）优先排产；
  普通工单已装炉部分保留在冻结炉次中，未装炉余量回到等待队列，
  按等待时长老化（等待越久优先级越高，同等条件下交期早者、编号小者优先）。
- **滚动更新**：`freezeTime` 之前开始的炉次冻结，不得移动；取消未冻结工单释放其配额，
  若 `toolingPrepared` 则计入 `compensationSlots × slotDuration` 的固定补偿时隙；
  取消已冻结工单被拒绝并产生警告。
- **目标**：最小化 `总拖期 + 清炉时间 + 补偿时间`；并列时按炉次编号顺序
  （炉次组成的字典序）取确定解。

## 使用

```bash
node src/cli.js plan examples/scenario.json --out plan.json      # 初始计划
node src/cli.js update plan.json examples/events.json            # 滚动更新
node src/cli.js compare examples/scenario.json                   # ≤5 工单时枚举对照
```

输出 JSON 包含：

- `runs`：炉次构成（编号、family、装载明细、起止、清炉、所在日）
- `quotaUsage`：按日按配方的配额用量
- `freezeBoundary`：冻结边界与冻结炉次编号
- `diff`：增量差异（新增/移除炉次、取消工单）
- `objective`：拖期 / 清炉 / 补偿 / 总计
- `compensations`、`warnings`、`status`（`ok` / `failed`，失败时 CLI 退出码为 1）

## 库 API

```js
import { createPlan, updatePlan } from './src/planner.js';
import { enumerateOptimal } from './src/enumerate.js';
import { normalizeScenario } from './src/model.js';
```

`enumerateOptimal` 对 ≤5 个工单（上限 6 个需求）枚举全部批次划分与炉次排列，
返回精确最优，用于与启发式结果对照。

## 失败判定

场景不可行时 `status: "failed"` 并给出 `reasons`，包括：不可拆分工单超容量、
同组工单配方不兼容或合计超容量、工单超过日配额、未知配方等。

## 测试

```bash
npm test    # 即 node --test
```

覆盖：正常混炉与配额可行、紧急抢占后续炉、取消已准备工单产生补偿且历史不变、
超容量/不兼容失败、≤5 工单枚举对照、CLI plan/update/compare 链路。
