# shiftsched

排班库：把不超过 10 人安排进不超过 12 个时段，每时段恰好两人。

## 约束

- 每时段两人，且两人都必须具备该时段资格（`Qualified` 输入）
- 相邻时段至少保留一名共同人员
- 任何人最多连续上 `MaxConsec = 3` 段

## 目标

1. 偏好费用（`Cost[p][s]` 之和）最小
2. 费用相同时，人员对序列按字典序最小（人员对内部已规范为小编号在前）

## API（`scheduler` 包）

- `Solve(p Problem) (Schedule, bool)` — 动态规划求解；状态为「上一段人员对 + 两人各自连班数」
- `Check(p Problem, s Schedule) error` — 约束检查器，逐条报告首个被违反的约束
- `TotalCost(p Problem, s Schedule) int` — 计算排班总费用

## CLI

```sh
go run ./cmd/scheduler < problem.json            # 求解，输出 JSON 排班
go run ./cmd/scheduler -check sched.json < problem.json   # 校验已有排班
```

输入 JSON：`{"num_people", "num_slots", "qualified": [[bool]...], "cost": [[int]...]}`。

## 测试

```sh
go test ./...
```

其中 `TestSolveMatchesBruteForce` 对短序列（≤5 人、≤5 段）做穷举验收：
逐一枚举全部合法排班，与 DP 求解器对比可行性、费用及字典序 tie-break 后的精确排班。
