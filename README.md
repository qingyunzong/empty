# flp — 小规模容量设施选址精确求解器

从至多 18 个候选站点中选择开放集合，把至多 12 个**不可拆分**的整数需求
分配给开放站点，满足**覆盖距离上限**与**整数容量**约束，最小化
**开放费 + 距离费**（需求量 × 距离）。

## 模型

- 站点：开放费 `open_cost`、整数容量 `capacity`、坐标 `(x, y)`
- 需求：整数需求量 `amount`（必须整体分配到一个站点）、坐标 `(x, y)`
- 约束：需求只能分给距离 ≤ `max_dist` 的开放站点；站点容量不得超限
- 目标：min Σ开放费 + Σ(需求量 × 分配距离)

## 算法

精确求解：枚举开站子集（2^18 以内），每个子集先算忽略容量的松弛下界
用于剪枝并汇总为**全局下界证书**，再对幸存子集做带回溯与后缀下界剪枝的
不可拆分配。结果附带**容量证书**（每站容量/已用/剩余/服务需求清单），
`Result.Verify` 可独立核验。给定有限 `budget` 时输出 `budget_ok` 判定与
`lower_bound` 界：若 `lower_bound > budget` 即证明预算不足。

## 用法

```sh
go test ./...          # 运行全部测试
go run ./cmd/flp inst.json   # 或 cat inst.json | go run ./cmd/flp
```

输入 JSON：`sites` / `demands` / `max_dist` / 可选 `budget`，输出含
`assignments`、`certificates`（容量证书）、`total_cost`、`lower_bound`、
`budget_ok`。不可行时进程退出码为 3。

## API

- `flp.Solve(inst, budget)`：精确求解（budget < 0 表示无预算）
- `flp.AssignOptimal(inst, open)`：固定开站集合（如全开）求最优分配
- `Result.Verify(inst)`：独立核验证书（覆盖、不可拆、容量、费用重算）
