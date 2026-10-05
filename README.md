# ev-fleet-sim

离散 tick 电动车队仿真库。TypeScript 编写，仅使用 Node.js 内置模块（`node:test` / `node:assert`），零运行时依赖。

## 语义模型

- **车辆路径给定**：每辆车的路径为节点序列，边能耗为正整数，每 tick 走一条边并整数扣电。
- **充电时段给定**：每个充电站以开窗口 `[start, end)`（tick 左闭右开）声明可充电时段，窗口外不授予。
- **充电占位容量**：每站 `capacity` 为同时充电上限；排队按 FIFO（同 tick 按配置顺序入队）。
- **等待可耗辅助能量**：在站排队且本 tick 未获授予的车辆，每 tick 扣 `auxDrainPerTick`，在 0 处截断。
- **电量 0 可停不能继续走**：电量不足以支付下一条边时车辆停在原地（`stranded`），不产生负电量。
- **同 tick 先到达再充电授予**：每 tick 阶段顺序为 ① 移动/到达入队 → ② 充电授予（本 tick 到达者已入队，可同 tick 获充）→ ③ 未获充的等待者扣辅助能量。
- **快照重放核对**：`simulate` 输出每 tick 快照与能量台账（move / charge / aux-drain 的 before/delta/after）；`verifyReplay` 从初始能量重放台账，逐 tick 比对快照、校验台账连续性与汇总账，并断言全程 `0 <= energy <= batteryCapacity`（无负电量、不超上限）。

## 使用

```ts
import { simulate, verifyReplay } from "./src/index.js";

const result = simulate({
  edges: [
    { from: "A", to: "S", energy: 2 },
    { from: "S", to: "Z", energy: 1 },
  ],
  vehicles: [
    { id: "v1", path: ["A", "S", "Z"], initialEnergy: 4, batteryCapacity: 10, chargeStops: ["S"], auxDrainPerTick: 1 },
  ],
  stations: [{ node: "S", capacity: 1, chargePerTick: 3, windows: [[0, 8]] }],
  maxTicks: 8,
});

verifyReplay(result); // { ok: true, errors: [] }
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test（需本机有 tsc，如 npm i -g typescript）
```

### 实际运行结果（2026-10-05，Node v22.22.1，TypeScript 7.0.2）

```
> tsc -p tsconfig.json && node --test "dist/test/*.test.js"
ok 1 - dist/test/simulation.test.js
# tests 1  # pass 1  # fail 0
```

文件内 9 个用例全部通过：

```
ok 1 - 移动按整数能耗扣减电量
ok 2 - 同 tick 先到达再充电授予
ok 3 - 充电占位容量限制与排队等待耗辅助能量
ok 4 - 电量不足可停不能继续走且电量不为负
ok 5 - 等待辅助能耗在 0 处截断不为负
ok 6 - 充电时段窗口外不授予
ok 7 - 充电不超过电池容量上限
ok 8 - 快照重放核对能量账：篡改快照或台账会被发现
ok 9 - 非法配置被拒绝
```

## 结构

- `src/types.ts` — 配置、台账、快照、校验报告类型
- `src/simulation.ts` — tick 仿真主循环（移动 → 授予 → 等待耗能）
- `src/verify.ts` — 快照重放与能量账核对
- `test/simulation.test.ts` — 9 个 `node:test` 用例
- `types/node-shim.d.ts` — `node:test` / `node:assert` 最小类型声明（离线环境无 `@types/node`）
