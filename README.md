# plugin-planner

插件规划库：每个插件声明 `requires`（前置能力）与 `provides`（提供能力），
从给定初始能力出发，求启用目标能力的**最低成本启用序列**。

- 纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖
- 插件上限 18 个（`MAX_PLUGINS`，`validateProblem` 强制校验）
- 顺序语义天然排除循环自供：插件的 `requires` 必须在启用**之前**已被其它来源满足，
  自我供给（`requires` 只有自己能产出的能力）或互相依赖环都无法启动

## 方法

1. **求解**：`src/solver.ts` 在"已具能力集合"状态空间（位掩码，2^caps）上跑
   Dijkstra 等代价搜索；能力只增不减、成本非负，故最短路即真实最优。
2. **核对一**：`src/bruteforce.ts` 的 `bruteForceMinCost` 穷举全部 2^n 插件子集，
   用"点火闭包"判定子集可行性（点不然的剩余必含环），取覆盖目标的最小成本。
3. **核对二**：同文件的 `verifyByRelaxation` 对全部状态做 Bellman-Ford 式松弛至不动点，
   是与 Dijkstra 独立的全状态空间算法。

三种方法结果一致才通过（`src/main.ts` 与测试均断言）。

## 使用

```bash
npm test    # tsc 编译 + node --test 运行全部测试
npm start   # 求解内置数据集，打印每步已具能力并做穷举核对
```

问题实例定义在 `src/data.ts`（15 个插件，含两个不可启动的循环自供反例）。
