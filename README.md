# contractopt

合同优化库（纯 Go 标准库，无第三方依赖）。

## 模型

- 每份合同：收入、资源占用向量（整数）、工期（占用连续若干时间段）、候选开始段集合、前置合同、互斥组（每组至多选一）、是否锁定。
- 资源上限为整数向量，按多个时间段分别给出：`Capacity[period][resource]`。
- 至多选择 `MaxContracts = 20` 份合同（含锁定合同）。
- 前置合同必须被选中且在其后续合同开始之前完结（`end(prereq) <= start`）。
- 已有合同锁定不可动：必须按 `LockedStart` 选中。
- 目标：收益最大；收益并列时资源总量（资源-时间段占用之和）最小。

## API

- `Solve(inst) (*Result, error)` — 分支定界精确求解；返回最优分配、收益、资源总量、依赖证书 `Cert`、上下界证据 `Bounds`。
- `Revise(inst, old) (*RevisionResult, error)` — 修订一份合同后重优化：先最小化改动合同数（选中状态或开始段不同即计一次），再收益最大、资源最小；返回旧/新分配与上下界证据 `Evidence`。
- `BuildCertificate` / `Certificate.Verify` — 依赖证书：为每份选中合同列出排期区间及每条前置的完结证明；`Verify` 对照实例重算全部证明并复检可行性。
- `BruteForce` / `BruteForceRevise` — 枚举全部子集与开始段分配的精确对照器，用于小实例验收。
- `Instance.Check` — 分配可行性完整校验（数量上限、锁定、候选开始段、前置完结、互斥、逐时段容量）。

## 界证据

- `Bounds.RevenueLower`：返回分配实际达成的收益（精确最优，即可证下界）。
- `Bounds.RevenueUpper`：松弛上界 = 锁定合同收入 + 其余合同中最高的 `20 - 锁定数` 个正收入之和，对任意可行分配有效。
- `Evidence.ChangesLower`：改动数下界（旧分配在新实例仍可行则为 0，否则为 1）。
- `Evidence.ChangesUpper`：实际达成的最小改动数。

## 测试

小实例枚举验收：随机生成含前置/互斥/锁定/多时段多资源的实例，`Solve` 对照 `BruteForce`、`Revise` 对照 `BruteForceRevise`，并校验证书与界证据一致性。

`go test ./...` 实际运行结果（go1.27.1 linux/amd64，2026-10-05）：

```
=== RUN   TestReviseMatchesBruteForce
--- PASS: TestReviseMatchesBruteForce (0.06s)
=== RUN   TestReviseMinChanges
--- PASS: TestReviseMinChanges (0.00s)
=== RUN   TestReviseNoChangeNeeded
--- PASS: TestReviseNoChangeNeeded (0.00s)
=== RUN   TestReviseLockedStaysPut
--- PASS: TestReviseLockedStaysPut (0.00s)
=== RUN   TestSolveMatchesBruteForce
--- PASS: TestSolveMatchesBruteForce (0.17s)
=== RUN   TestTieBreakPrefersLowerUsage
--- PASS: TestTieBreakPrefersLowerUsage (0.00s)
=== RUN   TestPrereqRequiresCompletion
--- PASS: TestPrereqRequiresCompletion (0.00s)
=== RUN   TestMutexAtMostOne
--- PASS: TestMutexAtMostOne (0.00s)
=== RUN   TestLockedContractForced
--- PASS: TestLockedContractForced (0.00s)
=== RUN   TestInfeasibleLockedSet
--- PASS: TestInfeasibleLockedSet (0.00s)
=== RUN   TestAtMostTwentyContracts
--- PASS: TestAtMostTwentyContracts (0.00s)
=== RUN   TestCertificateTamperFails
--- PASS: TestCertificateTamperFails (0.00s)
PASS
ok  	contractopt	0.236s
```
