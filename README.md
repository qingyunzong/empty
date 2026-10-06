# placement — 任务安置库

将至多 **18 个任务** 分配至至多 **4 台机器**，每机器有 CPU、内存两种资源容量，
支持 **亲和约束**（任务可运行的机器集合）与 **禁同机约束**（任务两两不得同机，
按对称关系处理）。费用 = 开机费用（凡承载 ≥1 任务的机器）+ 迁移费用（任务相对
旧方案换机时收取；新任务不收迁移费）。

- **目标**：最小化总费用；费用并列时取 **字典序最小** 的分配序列
  （任务按 ID 排序、机器按请求中给定顺序编号）。
- **不可行**：保持旧方案不变（`Result.Plan == Old`，`Cert.KeptOld = true`），
  费用仅为旧方案占用机器的开机费。
- **容量证书**：每个结果都附带 `Certificate`。可行时给出逐机用量对容量的核对表；
  不可行时给出可独立验证的原因（空亲和集 / 单任务超容 / 总量超容 /
  禁同机团大于可用机器数），否则以分支定界穷举搜索的节点数作为证据。
- **校验器**：`Check(req, plan)` 独立验证任意方案的容量、亲和与禁同机约束并计算费用。

仅使用 Go 标准库。

## API

```go
res, err := placement.Solve(req)   // req: Tasks / Machines / Old
res.Feasible                       // 是否找到可行新方案
res.Plan                           // task ID -> machine ID（不可行时为旧方案）
res.Cost                           // 开机 + 迁移总费用
res.Cert                           // 容量证书（含 Usage、Reason、Clique、NodesExplored）
cost, err := placement.Check(req, plan) // 独立校验任意方案
```

## 求解器

两阶段分支定界（`solve.go`）：

1. **阶段一**：字典序 DFS 求最优费用 C\*。旧方案（若仍可行）作为初始 incumbent；
   下界 = 已发生费用 + 剩余任务最小迁移费后缀和；并用聚合计容量必要条件
   （剩余任务总需求 ≤ 剩余总容量）剪枝。
2. **阶段二**：以下界 > C\* 剪枝重新按字典序 DFS，首个完整方案即为
   字典序最小的最优分配。

不可行快速证明（空亲和、单任务超容、总量超容、阻塞团，团用位掩码
Bron–Kerbosch 求取）在搜索前短路。

## 测试

- 单元测试：基本可行、字典序并列打破、禁同机、亲和与迁移、三类不可行证书、
  输入校验、校验器拒绝非法方案。
- **小实例穷举验证**：`TestExhaustiveSmallInstances` 以固定种子随机生成 500 个
  小实例（≤7 任务、≤3 机器），与暴力枚举全部 m^n 种分配逐一对比最优费用、
  字典序最小方案与不可行判定。
- 满规模与对抗性压测：18 任务 / 4 机器随机实例 40 组，最坏约 35 ms。

## 实际测试结果（go test ./...）

环境：go1.27.1 linux/amd64，2026-10-06 实测。

```
=== RUN   TestBasicFeasible
--- PASS: TestBasicFeasible (0.00s)
=== RUN   TestLexicographicTieBreak
--- PASS: TestLexicographicTieBreak (0.00s)
=== RUN   TestAntiColocationTieBreak
--- PASS: TestAntiColocationTieBreak (0.00s)
=== RUN   TestAffinityAndMigration
--- PASS: TestAffinityAndMigration (0.00s)
=== RUN   TestInfeasibleAggregateCapacityKeepsOld
--- PASS: TestInfeasibleAggregateCapacityKeepsOld (0.00s)
=== RUN   TestInfeasibleAntiColocationClique
--- PASS: TestInfeasibleAntiColocationClique (0.00s)
=== RUN   TestInfeasibleEmptyAffinity
--- PASS: TestInfeasibleEmptyAffinity (0.00s)
=== RUN   TestValidationLimits
--- PASS: TestValidationLimits (0.00s)
=== RUN   TestCheckRejectsBadPlan
--- PASS: TestCheckRejectsBadPlan (0.00s)
=== RUN   TestExhaustiveSmallInstances
--- PASS: TestExhaustiveSmallInstances (0.04s)
=== RUN   TestMaxSizeCompletes
--- PASS: TestMaxSizeCompletes (0.00s)
=== RUN   TestStressAdversarial
--- PASS: TestStressAdversarial (0.12s)
PASS
ok  	placement	0.196s
```
