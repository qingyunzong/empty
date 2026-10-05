# ev-fleet-sim

离散 tick 的电动车队仿真库。TypeScript 编写，仅使用 Node.js 内置模块
（`node:test` / `node:assert`），零运行时依赖。

## 语义规则

- **车辆路径给定**：每辆车沿固定的有向路段序列行驶，每段给定整数
  行驶时长 `ticks` 与整数总能耗 `energy`。
- **整数能耗**：路段能耗按 tick 分摊为整数（`floor(energy/ticks)`，余数
  分摊到前 `energy%ticks` 个 tick），全程合计严格等于路段总能耗。
- **充电时段给定**：每个充电桩由若干半开区间 `[start, end)` 定义运营
  时段，时段外不授予、不充能。
- **充电占位容量**：每个充电桩有并发占位上限 `capacity`，按
  （请求 tick, 车辆 id）FIFO 授予；车辆达到目标电量后释放占位。
- **等待可耗辅助能量**：排队等待的车辆每 tick 消耗 `auxDrainPerTick`
  的辅助能量，消耗在 0 处截断。
- **电量 0 可停不能继续走**：电量不足以支付当 tick 整数能耗时车辆
  进入 `stalled`，原地停驶，电量绝不出现负值。
- **同 tick 先到达再充电授予**：每个 tick 先执行移动/到达阶段，再执行
  充电授予阶段，因此当 tick 到达充电桩的车辆可在同一 tick 获得占位。
- **快照重放核对**：`snapshot()`/`restore()` 支持从任意 tick 重放并得到
  完全一致的事件日志与轨迹；`auditReplay()` 用事件日志重放逐 tick 电量，
  核对能量账（初始 + 充入 − 行驶 − 辅助 = 期末）且无负电量、无超容量。

## 使用

```ts
import { Simulation, auditReplay } from "ev-fleet-sim";

const sim = new Simulation({
  maxTicks: 60,
  recordHistory: true,
  chargers: [
    { id: "c1", node: "Hub", capacity: 1, ratePerTick: 3,
      windows: [{ start: 0, end: 20 }] },
  ],
  vehicles: [
    { id: "v1", startNode: "A",
      path: [{ to: "Hub", ticks: 2, energy: 4 }],
      batteryCapacity: 30, initialBattery: 20,
      chargePlan: [{ node: "Hub", targetBattery: 26 }],
      auxDrainPerTick: 1 },
  ],
});
sim.run();
const audit = auditReplay(config, sim.eventLog, sim.history);
console.assert(audit.ok, audit.failures);
```

## 目录

- `src/types.ts` — 配置、事件、快照类型
- `src/simulation.ts` — tick 引擎（移动/到达 → 充电授予两阶段）
- `src/ledger.ts` — 能量账、事件重放、审计
- `test/` — `node:test` 测试

## 测试

```
npm test    # tsc -p tsconfig.json && node --test dist/test/*.test.js
```

### 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
# tests 2  # pass 2  # fail 0   （两个测试文件）

simulation.test.js:
ok 1 - leg energy is spread as integers summing to the leg total
ok 2 - vehicle follows its fixed path with exact integer energy drain
ok 3 - battery 0: vehicle may stop but cannot keep driving, never negative
ok 4 - insufficient battery for the integer tick cost also stalls without going negative
ok 5 - arrival and charging grant happen in the same tick (arrival first)
ok 6 - occupancy capacity: FIFO queue, waiting drains auxiliary energy
ok 7 - charger windows: no grant outside operating hours, aux drain clamps at 0
ok 8 - invalid configs are rejected

replay.test.js:
ok 1 - snapshot restore replays to an identical trace and event log
ok 2 - two fresh runs of the same config are fully deterministic
ok 3 - event-log replay reproduces every snapshot and the ledger balances
ok 4 - audit flags a tampered negative battery in the history
ok 5 - audit flags a tampered event log (energy created out of thin air)
```

共 13 项断言测试，全部通过。
