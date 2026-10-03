# AS/RS 堆垛机调度模拟器

单机离线、零依赖（仅 Node.js 22 标准库 + `node:test`）。模拟立体库堆垛机执行入库 / 出库 / 移库任务，支持调度员取消任务并保证货位一致。

## 运行

```bash
node cli.js sim --in <dir> --out <dir>
node --test          # 运行全部测试
```

- 输入：`<in>/tasks.json`、`<in>/events.jsonl`
- 输出：`<out>/final_slots.json`、`<out>/ledger.jsonl`；存在冲突时额外写 `<out>/errors.jsonl` 并以 **exit=2** 退出（不中断处理）；用法/IO 错误 exit=1，无错误 exit=0。

## tasks.json

```json
{
  "slots": ["S1", "S2"],
  "initial_occupied": ["S2"],
  "tasks": [
    { "task_id": "IN1",  "type": "inbound",  "target": "S1", "priority": 1, "aisle": "A1" },
    { "task_id": "OUT1", "type": "outbound", "source": "S4", "priority": 3, "aisle": "A2" },
    { "task_id": "MV1",  "type": "move", "source": "S2", "target": "S3", "priority": 5, "aisle": "A1" }
  ]
}
```

- `type`：`inbound`（入库，需 `target`）/ `outbound`（出库，需 `source`）/ `move`（移库，两者都要）。
- `priority`：数值越大优先级越高（缺省 0），用于巷道汇合排序。
- outbound/move 的 `source` 自动视为初始有货（货物 id `initial:<slot>`）；也可用 `initial_occupied` 显式声明。

## events.jsonl

每行一个 JSON：`assign` / `start` / `finish` / `cancel` / `safe_point`（带 `task_id`），`block_aisle` / `unblock_aisle`（带 `aisle`）。行号即 `seq`，写进 ledger / errors。

## 核心机制

1. **任务状态机**：`created → assigned → started → done | cancelled`。
   - 未 `started` 的取消立即成功，释放货位预留。
   - `started` 的取消进入 `cancelling`：**目标位不释放**，直到该任务的 `safe_point` 事件触发补偿——出库/移库把货物放回源位，入库把货物送回站台并释放目标位。
   - 取消 `done` 任务记 `INVALID_STATE` 到 errors.jsonl，但处理不中断。
2. **巷道阻塞与汇合**：`block_aisle` 期间该巷道的 `finish` 被挂起（`deferred`，记录到达序）；`unblock_aisle` 时按 **优先级（高者优先）→ 到达序（先到先出）→ task_id（字典序）** 排序放行，顺序写入 ledger 的 `exit_order`，完全可复现。
3. **幂等**：同一任务的重复 `assign`/`start`/`finish`/`cancel` 返回首次结果的副本（`duplicate: true`），状态与 ledger 不重复变更；重复 `cancel` 保证返回同一结果（含 `INVALID_STATE` 失败结果，不重复记错误）。

## 货位一致性

- `assign` 时预留目标位（inbound/move）与源位（outbound/move）；目标被占用/预留 → `SLOT_CONFLICT`，源位为空 → `SLOT_EMPTY`，源位被预留 → `SLOT_CONFLICT`。
- `start` 时取货（源位移空、货物上堆垛机）；`finish` 时落货；取消补偿时回源位。
- 任意时刻一件货物只存在于一个位置（货位或堆垛机），测试对每个事件后不变量做校验。

## 输出

- `final_slots.json`：`slots`（每个货位 `occupied` / `goods` / `reserved_by`）+ `tasks`（每个任务终态）。
- `ledger.jsonl`：每次真实状态迁移一行（含 `seq`、结果、汇合 `exit_order`）。
- `errors.jsonl`：仅在有冲突/错误时写出，含 `INVALID_STATE`、`SLOT_CONFLICT`、`SLOT_EMPTY`、`UNKNOWN_TASK`、`UNKNOWN_EVENT`、`PARSE_ERROR`、`TASK_INVALID`、`EVENT_INVALID`。

## 测试

`node --test` 覆盖四条验收标准：

1. `test/sim.test.js` “acceptance 1”：3 任务 2 巷道，枚举全部 1680 种保序事件交错（另加 1680 种注入 block/unblock 窗口的变体），逐事件校验货位不变量、终态无两位同货位。
2. “acceptance 2”：started 任务取消后、`safe_point` 前目标位不释放（其他任务 assign 冲突），`safe_point` 后补偿释放。
3. “acceptance 3”：block 期间两个 finish 汇合，unblock 按优先级→到达序→task_id 放行，两次运行 ledger 逐字节一致。
4. “acceptance 4”：取消 done 任务记 `INVALID_STATE` 且不中断后续事件（库级 + CLI 级，exit=2）。
