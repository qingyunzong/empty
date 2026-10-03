# stacker-crane-sim

立体库堆垛机任务调度模拟器。Node.js 22, 仅标准库, 测试使用 `node:test`, 单机离线。

## 运行

```bash
node cli.js sim --in <dir> --out <dir>
node --test        # 运行全部测试
```

## 输入 (`--in` 目录)

- `tasks.json`: 任务数组, 或 `{ "tasks": [...], "slots": [{"id","item"}] }`。
  任务: `{task_id, type: inbound|outbound|move, item, from?, to?, priority?}`
  (inbound 需 `to`; outbound 需 `from`; move 需 `from`+`to`; priority 数值小者优先)。
  货位所属巷道按货位 id 前缀划分 (`A-01` -> 巷道 `A`)。
- `events.jsonl`: 每行一个事件。事件可带 `id` 用于幂等去重。
  - `assign` / `start` / `finish` / `cancel` / `safe_point`: `{type, task_id}`
  - `block_aisle` / `unblock_aisle`: `{type, aisle}`

## 核心机制

1. **状态机**: `created -> assigned -> started -> done|cancelled`。
   取消仅对未 `started` 的任务立即成功 (释放目标位预留); `started` 任务置
   `cancel_pending`, 目标位与源位预留均不释放, 待 `safe_point` 事件后补偿回源位
   (outbound/move 货物放回 `from`, inbound 仅释放 `to` 预留)。
2. **巷道阻塞**: `block_aisle` 期间该巷道内 `finish` 在出口排队 (记到达序);
   `unblock_aisle` 后按 **优先级升序 -> 到达序升序 -> task_id 字典序** 汇合放行,
   顺序完全可复现。
3. **幂等**: 带 `id` 的事件按 `id` 去重; `cancel` 结果按任务缓存, 重复 `cancel`
   返回同一结果, 不重复记账。

## 输出 (`--out` 目录)

- `final_slots.json`: 全部货位终态 `{slot_id: item|null}`。
- `ledger.jsonl`: 全部状态迁移与货位变更流水 (含 `finish_queued`/`compensate` 等)。
- `errors.jsonl`: 冲突记录 (`INVALID_STATE`/`SLOT_OCCUPIED`/`UNKNOWN_TASK`/`UNKNOWN_EVENT`/`BAD_EVENT`)。
  存在任何错误时进程退出码为 **2**, 否则为 0; 错误不中断后续事件处理。

## 货位一致性

- `assign` 时为目标位建立预留, 被占/被预留则记 `SLOT_OCCUPIED`。
- `start` 时源位货物上机, 同时保留回程预留, 保证取消补偿必然可放回原位。
- 任意时刻: 一件货物至多在一个货位; 一个货位至多一个占用者且不被他者预留;
  两个活跃任务不得声明同一货位 (测试在每事件后校验, 见 `Simulator#checkConsistency`)。

## 测试

- `test/simulator.test.js`: 状态机、幂等、补偿、阻塞放行排序 (8 例)。
- `test/acceptance.test.js`: 四条验收 —— 3 任务 2 巷道全交错枚举
  (1680 条交错 x 无取消/每位点插入 cancel+safe_point, 共 18480 个场景逐事件校验)、
  started 取消在 safe_point 前不释放目标位、block/unblock 汇合顺序可复现、
  cancel 已 done 记 `INVALID_STATE` 且不中断。
