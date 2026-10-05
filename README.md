# recipe — 整数配方优化器（精确有理数）

从配方库中选择**至多 8 种原料**，每种 **0 至 30 整数单位**，使总重量与
各营养素在**两个公开效价场景**下均落入有理区间；目标为**最小费用**，
并列时**原料种数更少**者优先。仅使用 Go 标准库。

## 模型

- `Rat`（rat.go）：最简分数 `num/den`（`den > 0`，`math/big.Int`）。
  **所有比较均交叉相乘**：`a ? b` 等价于 `a.num*b.den ? b.num*a.den`，
  全程无浮点。输出均为精确比例 `p/q`。
- `Instance`（model.go）：原料（单价、单重、双场景单位营养素）、重量与
  营养素有理区间、`MaxTypes=8`、`MaxUnits=30`、互斥对、加工先后约束。
- 可行性：单位界限、种数上限、重量/营养素区间（**两场景同时**）、互斥、
  使用集上诱导的先后关系无环。

## 求解（solve.go）

- 分支定界按原料序枚举 0..MaxUnits；上界侧超限即剪枝（总量只增）。
- 下界：对每个缺口（重量与各场景各营养素）取剩余原料中最优"营养素/费用"
  比值的松弛值，取各缺口最大值；并做容量可行性判定（剩余原料满额仍
  达不到下限则子树不可行）。
- 目标按 `(费用, 种数)` 字典序；并列费用时下界剪枝考虑种数。
- **预算耗尽**：保留最优费用上下界。每个被截断节点以其下界更新全局下界；
  回溯时祖先节点的下界支配所有被放弃的兄弟子树，保证
  `Lower ≤ 最优 ≤ Upper` 始终成立。

## 证书与核对

- **加工拓扑证书**（topo.go）：Kahn 算法给出使用原料的合法加工顺序；
  `VerifyOrder` 独立校验证书（使用集一致 + 所有先后边方向正确）。
- **独立枚举核对**（brute.go）：`BruteForce` 与求解器不共享搜索代码，
  穷举全部计数向量并保留最优，用于小规模实例的证据核对；CLI `-verify`
  自动比对。

## 使用

```sh
go run ./cmd/recipe -in examples/sample.json            # 求解，输出精确比例报告
go run ./cmd/recipe -in examples/sample.json -budget 20 # 预算截断，输出费用上下界
go run ./cmd/recipe -in small.json -verify              # 独立枚举核对
```

报告含：各原料整数单位、精确费用/重量、**双场景营养素比例**、
加工顺序证书及其校验位、费用上下界、搜索节点数。

## 测试（实际运行结果）

`go test ./... -count=1`（go1.27.1 linux/amd64）：

```
=== RUN   TestRatCrossMultiplicationCompare
--- PASS: TestRatCrossMultiplicationCompare (0.00s)
=== RUN   TestRatArithmeticExact
--- PASS: TestRatArithmeticExact (0.00s)
=== RUN   TestRatParseAndJSON
--- PASS: TestRatParseAndJSON (0.00s)
=== RUN   TestSmallScaleEnumerationCrossCheck   # 60 个随机小实例：求解器 == 独立枚举
--- PASS: TestSmallScaleEnumerationCrossCheck (2.58s)
=== RUN   TestExtremalBoundary                  # 极值验收：端点恰等、0/30 单位、31 单位不可行
--- PASS: TestExtremalBoundary (0.00s)
=== RUN   TestTwoScenarios                      # 单场景可行但另一场景失败者必须被拒
--- PASS: TestTwoScenarios (0.00s)
=== RUN   TestMutex                             # 互斥对不得同用，即使合并更便宜
--- PASS: TestMutex (0.00s)
=== RUN   TestPrecedenceCertificate             # 拓扑证书校验 + 先后成环判不可行
--- PASS: TestPrecedenceCertificate (0.07s)
=== RUN   TestTieBreakPrefersFewerTypes         # 同费用取种数少者
--- PASS: TestTieBreakPrefersFewerTypes (0.00s)
=== RUN   TestBudgetExhaustionBounds            # 19 实例 × 5 预算：下界 ≤ 枚举最优 ≤ 上界
--- PASS: TestBudgetExhaustionBounds (6.38s)
PASS
ok  	recipe	9.048s
```
