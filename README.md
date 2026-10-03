# PLC 包装线离线可线性化核验器

Node.js 22、仅标准库、`node:test`。急停 / 光电 / 气缸完成事件先落 append-only
本地日志，再离线判定控制命令历史是否可线性化。

## 结构

- `src/log.js` — append-only JSONL 日志。记录带单调 `seq` 与不倒退 `ts`；
  读取时校验：序号空洞报 `ERR_GAP`，时间倒挂报 `ERR_CLOCK`（`LogError.code`）。
- `src/machine.js` — 设备状态机：`{estop, photo, cyl}`，气缸
  `IDLE → MOVING_OUT → EXTENDED → MOVING_IN → IDLE`；命令 `extend/retract/reset`
  带前置条件，`cyl_done` 仅在运动中有效。
- `src/verifier.js` — 核验器。输入 `history = {ops, events, seed}`，输出
  `verdict ∈ {LINEARIZABLE, VIOLATION, UNKNOWN}`。
  - 候选交错：事件按 `ts` 排序，同刻事件按 src 优先级
    （cmd < plc < hmi < photo < cyl）+ 可重放随机（`mulberry32(hash(seed:id))`）
    打破平局；op 可在 `[start, end]` 内任意点线性化；`A.end < B.start ⇒ A ≺ B`。
  - 主算法：带回溯 + 记忆化的交错搜索；`referenceLinearizable` 为指数级
    全排列参考枚举，二者共用同一套状态机步进函数。
  - 命令确认事件（`kind:'ack'`，`args:{op, ok}`）必须与命令在线性化点的
    实际结果一致，否则该交错无效。
  - `findMinimalPrefix`：规范交错序上的最小违反前缀。
  - `findMinimalCertificate`：1-最小违反子集——删除其中任一事件/命令即通过。
  - UNKNOWN ≠ 违反：op 缺 `end`（pending）或搜索预算耗尽返回 UNKNOWN。
- `src/inject.js` — 故障注入 `drop/dup/dup/delay`，注入本身作为
  `{type:'inject', fault}` 记录入日志。
- `src/replayer.js` — 重放器：按 seq 消费日志（注入按序作用于事件流），
  按事件 `id` 去重（dup 幂等），再按规范交错序折叠出确定终态。
- `src/historyGen.js` / `src/refCheckWorker.js` — 随机历史生成器与对拍 worker。

## 运行

```sh
node --test
```

## 验收与真实结果

环境：Node.js v22.22.1。以下为实际运行输出。

1. **6 线程随机历史 vs 指数级参考枚举**（`test/concurrency.test.js`）：
   6 个 `worker_threads`，每线程 25 个随机历史（共 150），主算法与全排列
   参考枚举逐一对比，`mismatches = []`，两种判定均出现、`UNKNOWN = 0`。
   另做 300 个历史的 soak 对拍：`mismatches=0`（LINEARIZABLE=24 / VIOLATION=276）。
2. **注入重复急停仍可重放到同一状态**（`test/replay.test.js`）：
   `dup` 注入记录入日志，重放按 id 去重，`duplicatesCollapsed = 1`，
   含注入 / 不含注入 / 重复重放三者终态一致（`estop = true`）。
3. **不可线性化 → 最小证书**（`test/verifier.test.js`）：构造
   `estop@ts5` 落在 `extend[6,10]`（expect ok）之前的违反历史，
   返回最小违反前缀与 1-最小证书 `{e1(estop), o1(extend)}`，
   测试逐项验证删除证书中任一事件/命令后判定变为 LINEARIZABLE。
4. **缺 end 的 op 保持 UNKNOWN**（`test/verifier.test.js`）：
   `verdict = UNKNOWN, reason = 'pending-op'`，且不等于 VIOLATION；
   预算耗尽同样返回 UNKNOWN（`reason = 'budget-exceeded'`）。

错误路径（`test/log.test.js`）：序号空洞 → `ERR_GAP`；日志 ts 倒挂 →
`ERR_CLOCK`（读取与追加两条路径均覆盖）。

`node --test` 实际结果：

```
# tests 4
# pass 4
# fail 0
# duration_ms ~3.3s（4 个测试文件，共 12 个子测试，全部通过）
```
