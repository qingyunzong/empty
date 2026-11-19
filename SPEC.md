# 批处理库语义规范

本文件是被测库（`src/batcher.ts`）与独立参考状态机（`oracle/oracle.ts`）
共同遵循的唯一行为规范。两台实现各自独立编码，互不导入运行时代码，
只共享 `src/protocol.ts` 中的类型声明。

## 1. 虚拟时钟与事件处理框架

- 系统维护单调虚拟时钟 `now`，初始为 `0`，仅由事件的时间戳驱动。
- 事件按输入顺序逐个处理，每个事件处理完产出一个全量 `StateSnapshot`。
- 若事件时间 `at < now`：
  - `arrival` 事件：该请求被拒绝，原因 `clock-rewind`，不分配序号、不入系统；
  - 其余事件：直接抛错（调用方契约错误）。
- 当 `at > now` 时，先执行**时间结算**再执行事件动作（见 §5），
  因此同一时间戳上“先到期、后到达/flush”的优先级是确定的。

## 2. 配额与在途计数

- 每个租户有独立配额 `quota`；未知租户的到达直接拒绝，原因 `unknown-tenant`。
- `inFlight` = 该租户所有已接受但未完成请求数，即
  `open` + `retained` + `in-flight` 批次成员数之和。
- 请求在**进入系统时**（入 open 批次或入等待队列）分配全局递增序号 `seq`；
  被拒绝的请求不分配序号。
- 接受判定：`inFlight + 1 <= quota` 才能进入 open 批次；
  否则进入全局等待队列（排队，绝不丢弃），此时 `inFlight` 不增加。
- 配额在批次 `completed` 时按成员数一次性释放。

## 3. 批次生命周期

每个租户至多有一个 `open` 批次；批次 ID 为 `${tenantId}#${租户内批次序号}`。

- `open`：接受请求；首个成员进入时刻为 `openedAt`，
  超时截止 `deadline = openedAt + refreshTimeoutMs`（**含等号边界**：
  `now >= deadline` 即超时；等待队列中的停留时间不计入批次超时）。
- 关闭触发（优先级从高到低）：
  1. `size`：累计成员数达到 `batchSize`，在接受该请求的同一时刻立即关闭；
  2. `timeout`：时间结算时发现 `deadline <= now`；
  3. `flush`：显式 flush 且 open 批次非空。
- 关闭时若背压开启：批次转为 `retained` 整批保留，不派发、不拆批；
  背压关闭时按租户 ID 字典序重新派发为 `in-flight`。
- 关闭时若背压关闭：直接派发为 `in-flight`，
  `completedAt = dispatchedAt + downstreamLatencyMs`。
- 每个租户至多一个 `retained` 批次：背压期间新到达一律拒绝、
  超时检查与队列泵送全部暂停，该不变量自然成立。
- `in-flight` 批次在时间结算中到期后转为 `completed` 并释放配额。

## 4. 等待队列与排序

- 全局等待队列按 `(at, tenantId, seq)` 升序排列：
  跨租户按到达时间交错，时间相同取租户标识字典序，再相同取全局序号。
- 泵送采用**严格全局 FIFO**：队首租户无可用配额（或其 open 批次无法接收）
  时，泵送立即停止，后续租户不得插队；配额释放后的下一次结算再继续。
- 同一租户的请求始终按 `seq` 保持入队顺序，进入批次后顺序不变。
- 泵送仅在背压关闭时进行；背压开启期间队列冻结。

## 5. 时间结算（advance 或任意 `at > now` 的事件）

1. 推进 `now = at`；
2. 完成所有 `completedAt <= now` 的在途批次，
   按 `(completedAt, batchId)` 顺序逐个完成并释放配额；
3. 若背压关闭，执行稳态收敛（循环至无变化）：
   a. 关闭所有 `deadline <= now` 的 open 批次（`timeout`，
      按 `(deadline, batchId)` 顺序）并派发；
   b. 按全局 FIFO 泵送等待队列，接受的请求可能触发 `size` 关闭；
   队首受阻即停止。

背压开启时跳过第 3 步（完成仍正常发生、配额照常释放，但不泵送、不超时关闭）。

## 6. 各事件动作

- `arrival`：未知租户 → `unknown-tenant`；背压开启 → `backpressure`；
  配额不足 → 入等待队列；否则入 open 批次（无则新建），满批则 `size` 关闭。
- `flush`（租户必须已配置，否则抛错）：
  - 无 open 批次：记录 `flushNoop/no-open-batch`；
  - open 批次为空：记录 `flushNoop/empty-open-batch`
    （防御性边界：当前实现中 open 批次创建即带首成员，该分支不可达，
    但协议保留该原因以固定空批 flush 的输出形态）；
  - 非空：按 `flush` 关闭，背压中则保留，否则派发；随后做一次稳态收敛。
- `backpressure on`：仅置位背压标志，无其他副作用。
- `backpressure off`：清标志，先按租户字典序派发全部 retained 批次，
  再做稳态收敛（超时关闭 + 队列泵送）。
- `advance`：只触发时间结算，无额外动作。

## 7. 边界与差分测试要求

测试驱动两台状态机处理同一条事件流，逐事件 `deepEqual` 比较全量快照，
期望快照完全由参考机产生，被测库只提供实际输出。必须覆盖：

- 超时与满批在同一时刻触发（同时间戳到达，先结算后受理）；
- 配额恰满（第 `quota` 个请求接受、第 `quota+1` 个排队）；
- 背压期间到达（拒绝原因 `backpressure`）、期间 flush 保留、
  解除后 retained 重派与队列泵送恢复；
- 空批 flush（无 open 批次、空 open 批次两种 noop）；
- 超时边界 `deadline - 1` 不关闭、`deadline` 关闭；
- 完成释放配额后严格 FIFO 泵送、队首阻塞不插队；
- 固定种子随机事件流（到达/flush/背压/advance 混合）差分。
