# replplan — 副本规划 CLI

从至多 20 个机房中为至多 8 个分片规划副本：每片至少 `k` 个副本且两两位于不同故障域，
机房容量与访问费用给定，在预算约束下最小化总访问费用。仅使用 Go 标准库。

## 建模与算法

最小费用最大流（SPFA 连续最短路）：

```
source -> shard (cap k) -> (shard, domain) (cap 1) -> site (cap 1, cost=访问费) -> sink (cap=机房容量)
```

- `shard -> (shard, domain)` 容量 1 保证同一分片的副本落在不同故障域；
- `site -> sink` 容量为机房容量，跨分片共享；
- 费用非负，因此"至少 k 个"的最优解恰好使用 k 个副本；
- 流量不足 `shards*k` 或最小费用超过预算时判定不可行。

## 输入格式（JSON，stdin 或 `-input` 文件）

```json
{
  "k": 2,
  "budget": 500,
  "sites":  [{"id": "bj1", "domain": "beijing", "capacity": 3, "cost": 40}],
  "shards": [{"id": "shard-a", "costs": {"bj1": 55}}]
}
```

`shards[].costs` 可选，按分片覆盖指定机房的访问费；默认用 `sites[].cost`。

## 输出

放置方案 + `verified: true` + 证书（certificate）：每片副本数与故障域互异性、
每机房容量占用、总费用与预算的逐项校验。证书由独立的 `Verify` 函数复核，
不依赖求解器内部状态。

## 使用

```sh
go run . -input examples/input.json
cat examples/input.json | go run .
```

## 测试

```sh
go test ./...
```

`TestSolveMatchesBruteForce` 在 500 个微小随机实例（2–6 机房、1–3 故障域、
1–3 分片、k≤2）上将求解器结果与暴力枚举的基线逐一比对（含不可行判定与证书校验）。

## 实际测试记录

环境：go1.27.1 linux/amd64，命令 `go test ./...`：

```
=== RUN   TestSolveMatchesBruteForce
    planner_test.go:136: checked 307 feasible and 193 infeasible tiny instances
--- PASS: TestSolveMatchesBruteForce (0.01s)
=== RUN   TestSolveFixedInstance
--- PASS: TestSolveFixedInstance (0.00s)
=== RUN   TestBudgetEnforced
--- PASS: TestBudgetEnforced (0.00s)
=== RUN   TestInfeasibleNotEnoughDomains
--- PASS: TestInfeasibleNotEnoughDomains (0.00s)
=== RUN   TestInfeasibleCapacity
--- PASS: TestInfeasibleCapacity (0.00s)
=== RUN   TestVerifyRejectsBadPlans
--- PASS: TestVerifyRejectsBadPlans (0.00s)
=== RUN   TestValidation
--- PASS: TestValidation (0.00s)
PASS
ok  	replplan	0.016s
```
