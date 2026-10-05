# marshal — 编组 CLI

将至多 18 节车厢按**原序**切分为连续列车，每列受车型限制（车厢数、总长度、
总重量、危险品政策），并满足危险品**相邻**规则；目标为总费用最小，费用相同时
列车数最少。输出分段证书，并穷举全部切分与车型对照以交叉验证最优性。

仅使用 Go 标准库。

## 用法

```sh
go run . -problem examples/demo.json          # 求解并输出分段证书
go run . -problem examples/demo.json -enum    # 附加全部切分对照表
go run . -demo                                # 运行内置示例
```

## 输入格式（JSON）

```json
{
  "cars": [{"id": "C1", "length": 12, "weight": 30, "hazmat": "A"}],
  "incompatible": [["A", "B"]],
  "types": [{"name": "标准型", "maxCars": 4, "maxLength": 55,
             "maxWeight": 150, "cost": 160, "allowHazmat": true}]
}
```

- `cars`：1–18 节，顺序即原序；`hazmat` 为空表示非危险品。
- `incompatible`：禁止在同一列车内**相邻**的危险品类别对（无序）。
- `types`：`maxCars`/`maxLength`/`maxWeight` 为 0 表示不限；
  `allowHazmat: false` 的车型不能编挂任何危险品车厢。

## 方法

- 动态规划：`dp[i]` 为前 i 节车厢的最优（费用，列数），按字典序比较；
  区间长度/重量/危险品前缀和使每段可行性 O(1) 判定。
- 穷举验证：枚举全部 2^(n-1) 种切分（n≤18 → 至多 131072 种），每种切分内
  对每段独立取费用最低的可行车型，汇总取最优；证书中比对 DP 与穷举结果。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64。命令：`go test ./...`

```
ok  	marshal	0.012s
```

`go test ./... -v`：13 个测试全部 PASS——

```
--- PASS: TestCertificate (0.00s)
--- PASS: TestEnumTable (0.00s)
--- PASS: TestLoadProblem (0.00s)
--- PASS: TestEnumerateCounts (0.00s)
--- PASS: TestEnumerateMatchesDP (0.01s)   # 200 组随机问题 DP 与穷举交叉验证
--- PASS: TestEnumerateAllInfeasible (0.00s)
--- PASS: TestValidate (0.00s)
--- PASS: TestFeasibleLimits (0.00s)
--- PASS: TestFeasibleHazmat (0.00s)
--- PASS: TestSolveOptimal (0.00s)
--- PASS: TestSolveTieBreakFewerTrains (0.00s)
--- PASS: TestSolveInfeasible (0.00s)
--- PASS: TestSolveRespectsOrderAndContiguity (0.00s)
```

内置示例运行结果：8 节车厢最优为 2 列标准型，总费用 320.00；
穷举 128 种切分（125 种可行）验证一致。
