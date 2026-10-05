# thermal-scheduler

单机任务调度 CLI：至多 14 个任务，任务运行时每 tick 增加整数热量，
空闲每 tick 按固定速率冷却（不低于 0），温度不得超过上限，每个任务有截止期。
求 50 tick 上限内的最短工期（makespan），输出逐 tick 热量轨迹，
并用独立的逐 tick 完整状态搜索（穷举 BFS）核对最优性。

纯 TypeScript + Node.js 内置模块（`node:fs` / `node:test` / `node:assert`），零运行时依赖。

## 问题模型

- 单机器、任务不可抢占，一次只能运行一个任务。
- 每 tick：运行任务 i 则 `heat += heat_i`；空闲则 `heat = max(0, heat - coolRate)`。
- 每 tick 结束后 `heat` 必须 `<= heatCap`。
- 任务 i 的完成 tick 必须 `<= deadline_i`。
- 目标：最小化全部任务完成的 tick（makespan）；`maxTicks <= 50` 内无解则报不可行。

## 求解与核对（两条独立路径）

- `src/solve.ts` — 主求解器：在 `(doneMask, heat)` 状态空间上跑 Dijkstra，
  边权为流逝 tick 数，到达全完成掩码的最短时间即最短工期，并回溯出调度与热量轨迹。
- `src/brute.ts` — 独立核对器：逐 tick 层序穷举完整状态
  `(tick, heat, doneMask, runningTask, remainingTicks)`，BFS 首次出现全完成掩码的
  tick 即为可证明的最短工期。
- `src/simulate.ts` — 独立校验器：逐 tick 重放调度，检查重叠、时长、截止期、
  温度上限，并重新生成热量轨迹。

## 使用

```sh
npm test                                  # 编译 + 运行全部测试
npm run cli -- examples/sample.json       # 求解并输出轨迹（默认自动核对）
node dist/src/cli.js examples/sample.json --no-verify
```

实例格式见 `examples/sample.json`：`{ coolRate, heatCap, maxTicks, tasks: [{id, duration, heat, deadline}] }`。

## 实际运行结果（本仓库记录）

环境：Node.js v22.22.1，tsc 7.0.2。

`npm test` 输出（全部通过，耗时约 33s，主要用于 14 任务规模的穷举 BFS 核对）：

```
ok 1 - dist/test/scheduler.test.js
# tests 1
# pass 1
# fail 0
# duration_ms 33203.061975
```

测试文件内 8 个子测试全部通过，包括：

- 固定样例：最优 makespan = 39（两个独立求解器一致），轨迹全程不超温；
- 温度上限迫使插入 3 个冷却空闲 tick（makespan = 7）；
- 截止期不可达 / 温度上限 + 工期上限冲突 → 两个求解器一致判定不可行；
- 120 个随机实例（1–8 任务）+ 12 个随机实例（9–14 任务）：
  Dijkstra 与逐 tick 穷举 BFS 的 makespan / 不可行判定完全一致，
  且模拟器重放轨迹与求解器轨迹完全一致；
- 输入校验（任务数 >14、maxTicks >50、重复 id 等拒绝）。

`node dist/src/cli.js examples/sample.json` 实际输出（节选）：

```
makespan: 39 ticks
schedule:
  package: ticks 1..2
  lint: ticks 7..7
  compile: ticks 11..13
  deploy: ticks 20..22
  link: ticks 29..30
  unit-test: ticks 36..39
heat trajectory (tick: action -> heat):
  t= 1  package  -> 6
  t= 2  package  -> 12
  t= 3  idle     -> 10
  ...（中间为冷却/运行交替，峰值恰为上限 12）...
  t=39  unit-test -> 12
verify: simulator OK | exhaustive BFS OK
```
