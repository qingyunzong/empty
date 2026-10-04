# plugin-planner 插件能力规划库

每个插件声明**要求能力**（`requires`）与**可提供能力**（`provides`）及启用成本；
从显式给定的起始能力出发，求覆盖目标能力的**最低成本启用序列**。

## 模型与约束

- 插件仅当其 `requires` 全部被**启用它之前**已具备的能力覆盖时才能启用，
  因此循环互相提供能力的插件组（或 requires 与 provides 相同的自供插件）
  在起始能力无法打破循环时**永远无法自举启动**。
- 插件数至多 18 个（`MAX_PLUGINS`），状态空间 2^18 = 262144，逐状态精确求解。
- 成本非负；总成本为已启用插件成本之和，与启用顺序无关，顺序由依赖唯一约束。

## 求解与核对

- `solve()`（src/planner.ts:134）：状态掩码 DP。状态 = 已启用插件集合；
  预计算每个状态的能力位集后，按掩码升序（即拓扑序）做最短路松弛，
  取覆盖目标能力的最小成本状态并回溯启用序列，每步附带已具能力快照。
- `solveExhaustive()`（src/planner.ts:207）：独立的穷举状态搜索。枚举全部
  2^n 个子集，逐状态判定“是否存在合法启用顺序”，再取覆盖目标的最小成本，
  用于交叉核对主求解器。
- `validatePlan()`（src/planner.ts:262）：逐步重放计划，校验每步 requires
  均被满足、能力快照与成本累计正确、最终覆盖目标。

## 使用

```bash
npm test        # 编译并运行全部测试
npm run plan    # 运行内置示例（含循环依赖与自供插件样例）
node dist/src/cli.js problem.json   # 求解自定义问题
```

问题文件格式：

```json
{
  "initial": ["power"],
  "targets": ["serve-http"],
  "plugins": [
    { "id": "os", "requires": ["power"], "provides": ["kernel"], "cost": 2 }
  ]
}
```

说明：本环境 Node 构建未启用 TypeScript 类型剥离，故 `npm test` 先用全局
`tsc` 编译到 `dist/` 再运行 `node --test`；运行时仅用 Node 内置模块，零依赖。
`types/node-shim.d.ts` 为所用内置 API 的最小类型声明（环境无 @types/node）。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：11 个用例全部通过。

```
ok 1 - 线性依赖链：按依赖顺序启用并记录每步能力
ok 2 - 多条路径：选择总成本最低者，而非步数最少者
ok 3 - 循环依赖无法自举：互相提供对方所需能力但无起始支撑
ok 4 - 自供能力无法自举：requires 与 provides 相同仍须外部先具备
ok 5 - 循环可被起始能力打破：显式起始能力使环中插件可启动
ok 6 - 无需启用插件：起始能力已覆盖目标时成本为 0
ok 7 - 不启用与目标无关的插件
ok 8 - 插件数量上限：18 个可解，19 个报错
ok 9 - 非法输入：重复 id 与负成本被拒绝
ok 10 - 穷举状态搜索与主求解器一致（含 18 插件满规模）
ok 11 - 随机问题交叉核对：solve 与 solveExhaustive 结果一致且计划可重放
# pass 11 / fail 0
```

`npm run plan`（内置示例：起始能力 `power`，目标 `serve-http`，8 个插件）：

```
最低总成本: 10
启用序列（每步已具能力）:
  1. 启用 os (成本 2)            已具能力: [power, kernel]
  2. 启用 runtime (成本 3)       已具能力: [power, kernel, jit]
  3. 启用 self-signed-tls (成本 1) 已具能力: [power, kernel, jit, tls]
  4. 启用 web-server (成本 4)    已具能力: [power, kernel, jit, tls, serve-http]
逐步重放校验: 通过
穷举核对: 枚举 256 个状态, 最低成本 10 (最优状态 1 个), 与主求解器一致
```

示例中 `cycle-a`/`cycle-b`（循环互供）与 `self-boot`（自供）虽零成本提供
所需能力，但因无法自举启动而正确地未被选入；求解器选择了 1 成本的
`self-signed-tls` 而非 5 成本的 `cert-authority`。
