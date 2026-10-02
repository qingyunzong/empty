# rework-router

离线运行的质量追溯返工路由引擎与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

不合格品按工单路线依次经过诊断、维修、复检等工位。每条产线有每班人工分钟预算
（`budgetPerShift`），每个工位有每班产能（`capacityPerShift`，可用 `calendar` 按班覆盖）。

## 核心语义

- **逐工位试分配**：每一级 tentative 占用工位产能与产线预算；任一后续工位产能或预算
  不足时，该工单已创建的全部 tentative 占用按逆序回滚释放，不留半成品锁。
- **抢占**：高优先级工单可抢占普通工单，但仅当被抢占路线中与抢占者剩余路线重叠的
  工位构成**完整连续工位段**时才允许；抢占整体释放受害者占用并将其重新入队。
- **等待队列**：按 `(优先级权重 + 老化值)` 降序、提交序号升序排列；调度失败即老化 +1，
  老化的普通任务最终会被优先重排。
- **错误**：负工时（`NEGATIVE_MINUTES`）、未知工位（`UNKNOWN_STATION`）、单级工时超
  产线每班预算（`OVER_BUDGET`）等直接记入 `errors`，不进入调度。
- **枚举验证**：工单数 ≤ 4 时，`enumerateTimings` 枚举全部到达时序排列，逐一回放事件
  日志校验产能/预算不透支、释放不超量、跨班无半成品锁。

## 使用

```bash
node src/cli.js run examples/input.json     # 输出路由、预算扣减、抢占/回滚记录
node src/cli.js verify examples/input.json  # <=4 工单时枚举全部时序并校验
npm test                                    # node --test
```

输入 JSON：`{ lines, stations, orders, extraShifts? }`。工单：
`{ id, priority?: "normal"|"high", route: [{ station, minutes }] }`。

输出：`routes`（成功路由）、`budgetDeductions`（每级预算扣减）、`preemptions`、
`rollbacks`、`errors`、`waiting`、`events` 及 `verification`（事件日志不变量校验结果）。

## 库 API

```js
import { Scheduler, verifyEvents, enumerateTimings } from './index.js';

const scheduler = new Scheduler({ lines, stations });
scheduler.addOrder(order);
scheduler.run();            // 处理新到工单并排空等待队列
scheduler.advanceShift();   // 进入下一班：日历/预算重置，等待队列按老化重排
const result = scheduler.getResult();
```

## 布局

- `src/scheduler.js` — 调度引擎（试分配、回滚、抢占、老化队列、班次推进）
- `src/verify.js` — 事件日志不变量校验与 ≤4 工单时序枚举
- `src/cli.js` — CLI（`main(argv)` 可编程调用，亦可直接执行）
- `test/` — `node --test` 验收测试
