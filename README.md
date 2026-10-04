# round-runtime

每轮独立代际的运行时库（TypeScript + Node.js 内置库，零依赖）。

## 设计

- **轮次身份 = `(slot, generation)`**：`startRound(slot)` 使该槽位代际单调递增，每轮是独立代际。
- **迟到消息只归原轮**：消息携带 `(slot, generation, emitSeq)`。轮关闭后到达的 stdout / assert / exit 记为 `late` 证据，只挂在原轮上，绝不写入更新代际；引用不存在轮次的消息记为 `rejected`。
- **关闭后不能写新轮**：旧句柄的消息按原代际路由，新代际的证据与输出不受污染（测试 5 验证）。
- **结束语义**：`end()` 进入 `draining`，等 stdout 缓冲经 `setImmediate` 排空后才关闭（`closed-drained`）；`truncate(reason)` 明确截断，立即关闭并丢弃未排空字节（`closed-truncated`，记录丢弃字节数与原因）。
- **唯一轮终态**：关闭时生成冻结的 `FinalState`（status / exitCode / stdout / assertions / truncatedBytes / truncateReason），此后任何迟到流量都不会改变它。
- **完整引用证据**：每条消息在全局日志与所属轮各记一条 `Evidence`（到达序号 `arrivalSeq`、发出序号 `emitSeq`、处置 `applied|late|rejected`、原因），乱序由同一轮内 `emitSeq` 的非单调到达顺序体现。

## 运行

```sh
npm test        # tsc 编译 + node --test
npm run simulate  # 乱序投递模拟（seed=42），打印完整证据与唯一终态
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：10/10 通过（`# pass 10 # fail 0`）：

```
ok 1 - in-order round: drains stream and closes with exit code
ok 2 - end() waits for stream drain before closing
ok 3 - explicit truncation closes immediately and discards pending output
ok 4 - late stdout/assert/exit are attributed only to their original round
ok 5 - stale handle can never write into a newer generation
ok 6 - messages for a non-existent round are rejected
ok 7 - evidence log is complete with strictly increasing arrival sequence
ok 8 - out-of-order delivery: same seed yields identical unique final states
ok 9 - out-of-order delivery: shuffled emit order is visible in citations, not in terminal status
ok 10 - closed round final state never mutates under late traffic
```

`npm run simulate`（seed=42）输出（完整引用证据 + 唯一轮终态）：

```
== Evidence log (global arrival order) ==
#001 [applied ] A#gen1 stdout emit=1 payload="A1-out-1;" -- round A#gen1 open
#002 [applied ] A#gen1 exit   emit=5 payload="0" -- round A#gen1 open
#003 [applied ] A#gen1 assert emit=3 payload="A1-invariant" -- round A#gen1 draining
#004 [applied ] A#gen1 stdout emit=2 payload="A1-out-2;" -- round A#gen1 draining
#005 [applied ] A#gen1 stdout emit=4 payload="A1-out-3;" -- round A#gen1 draining
#006 [applied ] B#gen1 stdout emit=1 payload="B1-unflushed;" -- round B#gen1 open
#007 [applied ] A#gen2 stdout emit=1 payload="A2-out-1;" -- round A#gen2 open
#008 [late    ] A#gen1 stdout emit=6 payload="A1-LATE-out;" -- round A#gen1 already closed (closed-drained); attributed to original round only, never to a newer generation
#009 [late    ] A#gen1 assert emit=7 payload="A1-LATE-assert" -- round A#gen1 already closed (closed-drained); attributed to original round only, never to a newer generation
#010 [applied ] A#gen2 assert emit=2 payload="A2-invariant" -- round A#gen2 open
#011 [late    ] A#gen1 exit   emit=8 payload="7" -- round A#gen1 already closed (closed-drained); attributed to original round only, never to a newer generation
#012 [applied ] A#gen2 exit   emit=3 payload="0" -- round A#gen2 open

== Unique round final states (immutable after close) ==
A#gen1: closed-drained exit=0 stdout="A1-out-1;A1-out-2;A1-out-3;" asserts=["A1-invariant"] lateEvidence=3
B#gen1: closed-truncated exit=none stdout="" asserts=[] truncatedBytes=13 reason="operator kill" lateEvidence=0
A#gen2: closed-drained exit=0 stdout="A2-out-1;" asserts=["A2-invariant"] lateEvidence=0
```

## 文件

- `src/runtime.ts` — 核心：`Runtime` / `RoundHandle` / 证据与终态模型
- `src/scenario.ts` — 确定性乱序场景（种子化洗牌，emit 与 delivery 分离）
- `src/report.ts` — 证据与终态报告格式化
- `src/simulate.ts` — 模拟入口
- `test/runtime.test.ts` — 10 个 `node:test` 用例
- `types/node.d.ts` — 离线环境下的最小 Node 内置模块类型声明
