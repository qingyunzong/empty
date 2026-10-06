# tree-budget-allocator

拨款库在树上向叶子分配**整数**额度，最大化总收益。TypeScript 实现，零运行时依赖。

## 模型与语义

- 每片叶子一张**离散收益表** `payoff[x]`（`x = 0..cap`），**不要求凹性**。
- **固定启动费** `startupFee`：仅当 `x > 0` 时从该叶收益中扣除，即
  `gain(0) = payoff[0]`，`gain(x) = payoff[x] - fee (x > 0)`。
- 每个节点（含叶子）带**汇总上下界** `[min, max]`，约束其子树额度之和；
  根的汇总 additionally 不超过总额度 `budget`（整数，`0 ≤ budget ≤ 80`）。
- 目标：总收益最大；平局时取**叶子拨款向量字典序最小**者（叶子按 DFS 文档序编号）。
- 输出：最优收益、叶拨款向量、**每个节点的汇总** `aggregates`。

## 两个求解器

### 1. 树 DP（无跨子树约束）— `solveTreeDp(problem)`

对每个节点 `v` 与每个可行汇总 `s` 保留最优 `(收益, 向量)`。字典序决胜与 DP
兼容：子树对应叶向量的连续有序块，拼接向量的字典序比较可逐块进行。
收益表无需凹性——DP 是精确枚举所有整额汇总，不依赖边际递减。

### 2. 跨子树约束 + 启动费 — `new ConstrainedSolver(problem)`

跨子树差值约束 `|x_a - x_b| ≤ maxDiff`（**最多 10 条**）把不同子树耦合起来，
**不能独立优化子树再拼接**，因此使用全树分支定界：

- 按叶序、取值升序深度优先（即按字典序枚举），只严格改进 ⇒ 最优中字典序最小。
- 上界：对剩余松弛问题（已赋值叶固定、未赋值叶按已赋值伙伴收紧定义域、
  忽略两端均未赋值的跨约束）跑精确树 DP，松弛最优值是合法上界。
- **工作预算可续算**：`run(maxSteps)` 最多处理 `maxSteps` 个候选后返回，
  搜索状态保留，再次调用 `run(...)` 续算。搜索树**未闭合**时
  `status = "unclosed"`、`optimal = false`——即使已有可行现任解也**不得标最优**；
  闭合后才是 `"optimal"` 或 `"infeasible"`。
- **跨边证书**：结果附带每条跨约束的 `{aId, bId, xA, xB, diff, maxDiff, satisfied}`
  及搜索统计（探索节点数、剪枝数、累计步数）。

### 枚举核验 — `bruteForceSolve(problem)`

按字典序枚举全部叶向量，校验所有节点汇总界与跨约束，取最优。
测试中用于交叉核验两个求解器（`test/` 下含随机化对照）。

## 使用

```bash
npm test          # 编译 (tsc) 并运行全部测试
npm run solve -- examples/problem.json       # 无约束示例：输出各节点汇总
npm run solve -- examples/constrained.json   # 带跨约束示例：输出全树额度与跨边证书
```

```ts
import { solveTreeDp, ConstrainedSolver, bruteForceSolve } from './src';

const sol = solveTreeDp(problem);            // { feasible, payoff, vector, aggregates }

const solver = new ConstrainedSolver(problem);
let r = solver.run(1000);                    // 工作预算 1000 步
if (r.status === 'unclosed') r = solver.run(Infinity); // 续算至闭合
```

问题 JSON 格式见 `examples/`：`{ budget, root, constraints? }`，节点为
`{ id, min?, max?, leaf?: { payoff, startupFee? }, children?: [...] }`。
