# arm-track-simulator

多机械手搬运模拟器（TypeScript + Node.js 内置库，无第三方运行时依赖）。

## 功能

- **共享轨道区间互斥**：每个轨道段有 `lockCapacity`（1 即互斥锁），机械手必须先
  `acquire` 才能在该段上 `pick` / `place`；锁满时机械手阻塞等待。
- **动作 = 获取点 + 释放点序列**：动作由 `acquire` / `release` / `pick` / `place`
  步骤组成，按 tick 交错执行。
- **失败仅逆序释放已取得资源**：动作失败（前置条件不满足、动作结束仍持锁、或成为
  死锁牺牲品）时，只对**已完成步骤**做严格逆序（LIFO）回滚——`acquire` 逆操作释放锁，
  `pick`/`place` 逆操作把物品沿原路搬回。
- **循环等待输出图**：每个 tick 重建等待图（wait-for graph），发现环时记录
  `deadlock` 事件，包含环路径与 DOT 格式图，并回滚牺牲品解除死锁。
- **任意事件快照 + 重放核对**：`onEvent` 钩子可在任意事件处 `snapshot()`；
  `replayEvents()` 从初始配置重放事件日志，在**每个事件后**核对：
  - 物品唯一位置：每个物品恰好出现在一个位置（某轨道段或某机械手夹爪）；
  - 资源守恒：机械手的锁声明与轨道段的持锁记录完全一致，容量不超限；
  并逐快照比对重放状态与实时快照是否一致。

## 结构

- `src/model.ts` — 世界状态、步骤/动作类型、不变量校验 `verifyWorld`
- `src/waitgraph.ts` — 等待图、环检测、DOT 输出
- `src/simulator.ts` — 事件溯源模拟器（阻塞、死锁检测、逆序回滚、快照）
- `src/replay.ts` — 事件日志重放与不变量核对
- `src/scenarios.ts` — 示例场景（交叉搬运 / 循环等待）
- `src/main.ts` — 演示入口
- `test/simulator.test.ts` — 6 个测试

## 使用

```sh
npm test           # 编译 (tsc) 并运行 node:test 测试
npm run typecheck  # 仅类型检查
npm run demo       # 运行演示：事件日志、死锁 DOT 图、快照重放核对
```

说明：本环境的 Node 构建未启用原生 TypeScript 类型擦除，因此 `npm test`
先用 `tsc` 编译到 `dist/` 再运行纯 JS；运行时只用 Node 内置模块
（`node:test`、`node:assert`）。
