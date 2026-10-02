# rework-router

可离线运行的质量追溯返工路由库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

不合格品进入返工路线，依次经过 **诊断 → 维修 → 复检** 等工位（路线长度任意）。
每条产线有每班人工分钟预算，每个工位有每班产能（日历可逐班不同）。

## 语义

- **原子分配**：逐工位试分配，tentative 占用真实写入共享状态；若后续工位
  无可行产能或预算不足，该工单已创建的全部 tentative 占用被精确回滚并释放
  （记录 `atomic-rollback`），不留半成品锁。
- **抢占**：高优先级返工可抢占普通工单，但只能抢占**完整连续工位段**
  （其整条路线）。若驱逐全部有冲突的普通工单后仍无法满足整段路线，则不
  发生任何抢占。被抢占的普通工单整体回滚（记录 `preempted`），保留原始
  到达班次（老化），按老化从先到后尝试重排；排不下的回到等待队列。
- **等待队列**：按优先级（高优先）→ 老化（到达班次最早）→ id 排序。
- **错误**：负工时（`negative-minutes`）、未知工位（`unknown-station`）、
  单步工时超产线预算（`over-budget`）为工单级错误，该工单被排除并记录，
  其余工单照常调度。

## 输入格式（JSON）

```json
{
  "shifts": 4,
  "lines": [{ "id": "L1", "budgetPerShift": 480 }],
  "stations": [
    { "id": "DIAG", "lineId": "L1", "capacityPerShift": [0, 0, 50, 50] }
  ],
  "orders": [
    {
      "id": "WO-1", "priority": "high", "arrivalShift": 0,
      "route": [
        { "station": "DIAG", "minutes": 50 },
        { "station": "REP",  "minutes": 50 },
        { "station": "INSP", "minutes": 50 }
      ]
    }
  ]
}
```

- `budgetPerShift` / `capacityPerShift`：数字（每班相同）或长度等于 `shifts` 的数组（逐班日历）。
- `priority`：`high` | `normal`（默认 `normal`）；`arrivalShift` 默认 0。
- 路线步骤按顺序执行：后续步骤排在同一或更晚班次，且不早于 `arrivalShift`。

## 输出

`schedule(input)` 返回：

- `routes`：成功路由（每步的工位、班次、分钟、所属产线）。
- `budgetDeductions`：每级（每步）预算扣减明细。
- `preemptions`：抢占记录（抢占者、被驱逐/被重排工单、工位段、落位）。
- `rollbacks`：回滚记录（`atomic-rollback` / `preempted`，含释放的占用）。
- `waiting`：仍在等待的工单 id（按队列顺序）。
- `errors`：工单级错误（`code` + `message`）。
- `stationUsage` / `lineUsage` / `summary`：最终占用与统计。

## CLI

```sh
node src/cli.js examples/input.json            # 结果 JSON 打印到 stdout
node src/cli.js input.json --out result.json   # 写入文件
node src/cli.js input.json --verify            # 附带约束校验，违规时退出码 1
```

退出码：`0` 正常；`1` 校验失败；`2` 用法/IO/结构性输入错误。

## 库 API

```js
import { schedule } from './src/scheduler.js';
import { normalizeInput } from './src/model.js';
import { verifySchedule, enumerateAssignments } from './src/verify.js';

const result = schedule(input);
verifySchedule(normalizeInput(input), result);   // { ok, violations }
enumerateAssignments(norm, ['WO-1', 'WO-2']);    // ≤4 工单时枚举全部可行路线时序
```

## 测试

```sh
npm test        # 即 node --test
```

覆盖验收项：三级均成功的原子分配；第二/三级失败导致前级精确回滚；预算不足
回滚；高优先级抢占完整连续工位段且老化普通任务最终重排；抢占全有或全无；
等待队列优先级+老化排序；负工时/未知工位/超预算为错误；≤4 工单时枚举路线
时序验证调度结果。最近一次真实执行结果见 `docs/test-results.txt`。
