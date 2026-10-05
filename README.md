# transport — 双场景固定分配运输规划库

仅使用 Go 标准库。一个固定分配（订单不可拆，每订单恰好一条线路）必须
同时满足两个公开容量场景；目标为两场景费用较大者的最小值（minimax）。
规模上限：8 订单、6 线路（见 `MaxOrders` / `MaxLines`）。

## 模型

- **双场景容量**：每条线路在两个场景下各有容量 `Line.Capacity[2]`。
- **线路启用固定费**：线路一旦被任一订单使用即计入 `Line.FixedCost`。
- **共享温区容量**：`ZoneCapacity[zone][scenario]` 为跨所有线路共享的
  温区容量池。
- **时窗与前置**：每订单有时窗 `[Earliest, Latest]`；到达耗时
  `Travel[scenario][order][line]` 随场景不同，同一方案须各自时窗合法；
  `Order.Predecessor` 要求前置订单到达不晚于本订单（两个场景分别成立）。
- **费用**：`Cost[scenario][order][line]` 随场景不同；方案费用取两场景
  较大者。

## 求解与证书

- `Solve`：分支定界，增量检查容量/温区/时窗，叶节点检查前置约束；
  `Trace` 保存 Pareto 前沿（两场景费用空间中的非支配可行方案）以及
  最优上下界 `BestUpper` / `BestLower`（搜索完备时二者闭合等于最优值）。
- `BuildCertificate`：双场景逐线路证书（各场景载量/容量、到达时刻、
  时窗合法性、费用、温区池用量、前置约束标志）。
- `VerifyCertificate`：重算并核对证书与分配的一致性。
- `Enumerate`：全分配枚举（`lines^orders`），作为小规模问题的
  真值预言机核对 `Solve`。

## 测试结果（实际运行）

环境：go1.27.1 linux/amd64。命令：`go test ./... -v -count=1`

```
=== RUN   TestSolveMatchesEnumeration
--- PASS: TestSolveMatchesEnumeration (0.00s)
=== RUN   TestRandomizedAgainstEnumeration
--- PASS: TestRandomizedAgainstEnumeration (0.04s)
=== RUN   TestCertificateTamperDetected
--- PASS: TestCertificateTamperDetected (0.00s)
=== RUN   TestScenarioSpecificTimeWindows
--- PASS: TestScenarioSpecificTimeWindows (0.00s)
=== RUN   TestPredecessorAcrossScenarios
--- PASS: TestPredecessorAcrossScenarios (0.00s)
=== RUN   TestFrontierNonDominated
--- PASS: TestFrontierNonDominated (0.00s)
=== RUN   TestSizeLimits
--- PASS: TestSizeLimits (0.00s)
PASS
ok  	transport	0.054s
```

注：若构建缓存目录只读，使用 `GOCACHE=/tmp/gocache go test ./...`。
