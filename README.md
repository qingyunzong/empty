# hold-alert

告警库：在信号保持序列上，输出值大于阈值且持续至少 `d` 个 tick 的区间。
仅使用 TypeScript + Node.js 内置库（运行时零依赖，测试用 `node:test`）。

## 语义

- **区间判定**：物化序列中一段极大连续 tick（`tick` 逐一递增 1）且每个值
  `> threshold`，当持续长度 `end - start + 1 >= minDuration` 时输出告警区间。
- **缺失打断**：缺少某个 tick 会截断当前段，前后各自独立判定。
- **同 tick 更正**：同一 tick 后到的事件视为更正，先替换已存值再参与判定。
- **迟到事件**：事件可乱序到达。每次事件后重算全部区间并与已发射集合做
  diff——新区间发 `alert`，失效区间发 `retract`（迟到更正可撤回已发告警；
  段被延长时表现为撤回旧区间 + 发射新区间）。
- **起止证据**：每个区间携带 `startEvidence` / `endEvidence`（首末两个高于
  阈值的样本的 tick 与值）。

## 结构

- `src/alertEngine.ts` — `AlertEngine`（流式引擎，分段扫描实现）与
  `computeIntervalsBySegments`。
- `src/reference.ts` — `computeIntervalsTickByTick`，逐 tick 状态机参考模型，
  与引擎实现结构独立，用于对照。
- `test/alert.test.ts` — 语义单测 + 500 轮随机流（含迟到与更正）下
  引擎净告警集合 ↔ 逐 tick 参考模型 ↔ 分段扫描的三方对照。

## 运行

```sh
npm test   # 先 tsc 编译到 dist/，再用 node --test 跑测试
```

需要全局可用的 `tsc`（本环境为 TypeScript 7.0.2）；Node 为 v22.22.1。
`test/node-shims.d.ts` 提供了 `node:test` / `node:assert/strict` 的最小类型
声明，以便离线环境下无需 `@types/node`。

## 实际测试结果（2026-10-05 记录）

`npm test` 退出码 0。逐条输出（`node dist/test/alert.test.js`）：

```
# Subtest: hold-sequence alert semantics
    ok 1 - emits one interval with start/end evidence when value > threshold for >= d ticks
    ok 2 - a missing tick breaks the run, so two short runs raise no alert
    ok 3 - applies a same-tick correction before evaluation
    ok 4 - a late below-threshold event retracts a previously emitted alert
    ok 5 - a late event filling a gap can create an alert retroactively
    ok 6 - extending a run replaces the old interval (retract + alert)
# Subtest: engine vs tick-by-tick reference model
    ok 1 - agrees on a hand-built sequence with gaps and corrections
    ok 2 - matches the reference on randomized streams with late events and corrections
# tests 8
# pass 8
# fail 0
```
