# line-sim — 产线模拟库

TypeScript 编写的离散 tick 产线模拟库，仅依赖 Node.js 内置模块（运行期零依赖）。

## 模型

- **Buffer（缓冲区）**：容量按所有物料单位总数计算；`inject`/`extract` 是系统与外界的物料出入口，全部计入守恒账本。
- **Machine（机器）**：按 recipe 从输入缓冲消耗物料，加工 `processTicks` 个 tick 后产出。
- **阻塞（Blocking）**：产出时若输出缓冲放不下整批成品（all-or-nothing），机器进入 `blocked`
  并**持有成品**，不能提前释放机器、不能开始新工单，直到缓冲有空间整批入库。
- **故障（Failures）**：按 `{ tick, repairTicks }` 调度。加工中故障会**暂停**进度，
  修复后从断点续行；阻塞中故障则继续持有成品。修复完成的机器当 tick 即可参与后续阶段。

## Tick 阶段顺序

每个 tick 严格按以下顺序执行：

1. **故障/维修**：应用本 tick 的故障调度；维修倒计时，修好的机器恢复中断前状态。
2. **完工**：加工中的机器推进 1 tick；达到工时则持有的投入品转换为成品（持于机内）。
3. **入库**：持有成品的机器尝试整批放入输出缓冲；放不下则保持 `blocked`。
4. **开工**：空闲机器在投入品齐备时消耗 recipe 输入并开始新工单。

因此同一 tick 内一台机器可以「完工 → 入库 → 开工」连续发生（见测试 2）。

## 物料守恒

`MaterialLedger` 按物料类型记账：

```
expected(item) = injected(item) - extracted(item) + Σ(完工产出 - 完工投入)
```

每个 tick 结束后，账本与物理清点（所有缓冲 + 机内持有投入/成品）逐项核对，
不一致即抛错（`strictConservation`，默认开启）。每 tick 同时记录不可变快照
（`sim.snapshots`）与事件流（`sim.events`），可用于逐 tick 复核。

## 用法

```ts
import { Simulation } from "./src/index.js";

const sim = new Simulation();
sim.addBuffer({ id: "raw", capacity: 10 });
sim.addBuffer({ id: "done", capacity: 1 });
sim.addMachine({
  id: "M1",
  recipe: { inputs: { ore: 2 }, outputs: { bar: 1 }, processTicks: 3 },
  input: "raw",
  output: "done",
  failures: [{ tick: 5, repairTicks: 2 }],
});
sim.inject("raw", "ore", 6);
sim.run(20);
console.log(sim.events, sim.snapshots.at(-1));
```

## 测试

```
npm test        # tsc 编译后运行 node --test（node:test + node:assert，无外部依赖）
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
> line-sim@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js

# tests 1
# pass 1
# fail 0
```

测试文件逐条明细（`node dist/test/simulation.test.js`）：

```
ok 1 - machine consumes inputs and produces outputs after processTicks
ok 2 - same tick executes completion, unload, then start in order
ok 3 - full output buffer blocks the machine; finished goods are held, machine not released early
ok 4 - breakdown pauses processing mid-job and resumes with preserved progress
ok 5 - breakdown while blocked keeps holding finished goods
ok 6 - material conservation holds every tick on a two-machine line with failures
ok 7 - conservation check detects material appearing from nowhere
ok 8 - per-tick snapshots are immutable deep copies of the model state
ok 9 - inject and extract are recorded as events with their tick
# tests 9
# pass 9
# fail 0
```

## 目录

- `src/buffer.ts` — 容量受限的物料缓冲
- `src/machine.ts` — 机器状态机（idle / processing / blocked / down）
- `src/ledger.ts` — 分物料类型的守恒账本
- `src/simulation.ts` — tick 调度、事件流、逐 tick 快照与守恒核对
- `test/simulation.test.ts` — 9 个测试（node:test）
- `types/node-shim.d.ts` — 离线环境下 node:test / node:assert 的最小类型声明
