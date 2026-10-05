# bitplanner

有限域布尔规划器（TypeScript + Node.js 内置库，无第三方依赖）。

- 状态：至多 **12 个布尔位**（位掩码）+ 可选**有限资源**向量（只消耗、不恢复）。
- 动作：前置条件（require/forbid 掩码）、无条件效果、**条件效果**、资源消耗；单位成本 1。
- 语义：前置条件与条件效果的触发条件都在**旧状态**上求值；一个动作的全部被触发效果**同时**作用；若同时效果对同一位既置 1 又清 0（**互斥**），该动作在该状态被**拒绝**（不适用）。无条件效果的静态互斥在问题加载时直接报错。

## 构建与测试

```sh
npm test        # tsc 编译 + node --test（33 个断言测试）
npm run build   # 仅编译到 dist/
```

实际测试输出记录在 `RESULTS.md`。

## CLI

```sh
node dist/src/cli.js plan     examples/rocket.json   # 最短证书（BFS）
node dist/src/cli.js closure  examples/lights.json   # 完整可达闭包（含最短深度）
node dist/src/cli.js verify   examples/lights.json cert.json   # 重放+目标+最优性核对
node dist/src/cli.js bound    examples/lights.json   # 可检查启发式下界
node dist/src/cli.js astar    examples/rocket.json   # A*（输出全部下界记录供审计）
node dist/src/cli.js iddfs    examples/rocket.json   # 回溯学习搜索
node dist/src/cli.js frontier examples/rocket.json --pause 2 --out snap.json
node dist/src/cli.js frontier examples/rocket.json --resume snap.json
```

## 问题格式（JSON）

```json
{
  "bits": 4,
  "initial": 1,
  "goal": { "requireMask": 13, "forbidMask": 2 },
  "resources": { "fuel": 3 },
  "actions": [
    { "name": "fly-out", "requireMask": 1, "forbidMask": 2,
      "setMask": 2, "clearMask": 1, "cost": { "fuel": 1 },
      "cond": [ { "requireMask": 4, "setMask": 8 } ] }
  ]
}
```

## 设计要点

- **BFS（`src/bfs.ts`）**：单位成本下的最短证书与完整可达闭包（深度即最短距离）。前沿（FIFO 队列 + 已访问集 + 展开日志）可序列化为 JSON；`Bfs.restore` 恢复后继续展开的**访问顺序与不暂停运行完全一致**（测试逐点核对多个暂停点）。
- **启发式下界（`src/heuristic.ts`）**：h_max 风格，按目标条件分别做删除松弛（正目标：忽略清除效果/forbid 前置/资源）与添加松弛（负目标：对偶）。返回完整距离向量，`checkLowerBound` 可独立重算审计；A* 输出的每条 `BoundRecord` 都可在事后核对。测试在随机小问题上对**完整可达闭包的每个状态**穷举核对 `h(s) ≤ h*(s)`（h* 由该状态起跑的完整 BFS 求得），并核对 `h=∞` 蕴含目标不可达、A* 最优值与 BFS 一致。
- **回溯学习（`src/iddfs.ts`）**：迭代加深 DFS + 声音（sound）的失败学习——仅当某状态的全部适用子节点都被完整探索（未被环切）且各自持有预算 ≥ r-1 的失败证书时，才记录 `failed[s]=r`；之后的访问仅当剩余预算 ≤ r 才剪枝。因此**学习永远不会排除未探索的可行路径**；环切只去掉严格环（同位同资源，可删环得到更短合法计划）。随机问题上与 BFS 最优值逐一核对，DFS 与 BFS 可达闭包逐一核对。
- **证书验证（`src/verify.ts`）**：逐步重放（前置/资源/互斥），检查目标，并用完整 BFS 核对最短性。

## 目录

```
src/model.ts      语义核心：校验、动作应用（旧状态求值/互斥拒绝/资源）
src/bfs.ts        BFS、可达闭包、可序列化前沿
src/heuristic.ts  可采纳下界（可检查）+ A*
src/iddfs.ts      迭代加深回溯搜索（声音学习）+ DFS 闭包
src/verify.ts     证书重放与最优性核对
src/cli.ts        CLI（runCommand 供进程内测试）
test/             node:test 测试（含带种子随机问题生成器）
examples/         lights / swap / rocket 示例
```
