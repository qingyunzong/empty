RPA宿主需要TypeScript动作执行组件，页面动作可能超时后仍成功。调用方为每次意图提供稳定ID、前置指纹、动作函数和只读结果探测器；超时后只能探测，确认未执行才允许再次动作，无法确定则返回待人工决断。把状态变更写入可注入的持久日志，恢复时先探测未决意图。同一ID并发提交共享一个结果，指纹不一致报错。用可控Promise和故障存储覆盖成功后掉线、探测迟到、恢复期间重复提交，证明非幂等动作不会盲目重试。

## 设计

核心类 `ActionExecutor`（`src/executor.ts`），围绕 append-only 持久日志（`EventStore`）实现：

- **超时后只探测**：动作与超时竞速，超时只代表“暂时不知道结果”，底层 Promise 仍可迟到完成；
  此后只调用只读 `probe()`。`executed` 复用成功、`not_executed` 才允许再次动作、
  `unknown`（含探测器抛错）一律升级 `manual_review`，绝不盲目重试。
- **可注入持久日志**：每次状态变更（`submitted/action_started/action_timed_out/probed/
  resolved/manual_review`）先串行落盘再推进，写入通过带永久消费的串行队列执行，
  失败包装为 `StoragePersistenceError` 抛给调用方，不产生游离 Promise 拒绝。
- **恢复先探测**：构造时重放日志重建状态；未决意图先跑只读探测，再决定复用成功、
  重新执行（仅在确认未执行后）或人工决断。缺少处理器的意图挂起，等 `submit` 补提。
- **同一 ID 共享结果**：提交先同步登记受控 Promise 槽位，并发/重复提交合并到同一结果；
  前置指纹不一致抛 `FingerprintMismatchError`，动作不会被重复触发。

## 关键文件

- `src/types.ts`：意图、探测裁决、日志事件、存储接口
- `src/executor.ts`：执行器状态机与崩溃恢复
- `src/memory-store.ts`：内存存储与故障注入存储 `FaultyEventStore`
- `src/controlled-promise.ts`：测试用可控 Promise
- `src/action-executor.test.ts`：21 个用例，覆盖超时后成功、探测迟到、成功后掉线、
  恢复期间重复提交等场景，断言非幂等动作的实际调用次数

## 命令

- `npm run build`：编译生产代码到 `dist`（不含测试）
- `npm test`：类型检查测试并编译到 `dist-test`，用 Node 内置 test runner 执行
