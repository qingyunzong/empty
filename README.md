# testplan — 测试规划 CLI

从至多 24 个测试中选出子集，覆盖全部公开分支（public branches）与成对交互
（pairwise interactions）。测试之间存在启动前置（`requires`，传递闭包），
选中集合受总时限（`timeLimit`）约束。优化目标为字典序：**先总成本最少，
再测试数最少**。仅使用 Go 标准库。

## 用法

```sh
go build -o testplan .
./testplan example > demo.json          # 生成示例实例
./testplan solve demo.json              # 求解并打印覆盖证书与搜索界
./testplan solve -exhaustive demo.json  # 同时用穷举核对
./testplan solve -json demo.json > cert.json
./testplan verify demo.json cert.json   # 校验证书（重新证明最优性）
```

`solve` 可选 `-max-nodes N` 限制分支定界节点数；预算耗尽时输出
`FEASIBLE`（已找到解但最优性未证）或 `UNKNOWN`（未找到解），
证书中的搜索界仍然成立。

## 实例格式

```json
{
  "name": "example",
  "branches": ["login/ok", "login/fail"],
  "pairs": ["os=linux,browser=firefox"],
  "timeLimit": 40,
  "tests": [
    {"id": "smoke", "cost": 4, "time": 6,
     "requires": ["setup"],
     "branches": ["login/ok"],
     "pairs": ["os=linux,browser=firefox"]}
  ]
}
```

- `branches` / `pairs`：必须覆盖的需求集合。
- `cost`：优化目标（非负）；`time`：计入总时限（非负）。
- `requires`：启动前置，选中某测试必须同时选中其全部传递前置（允许环，
  环上测试同进同出）。

## 求解器

- **分支定界**（`solver/solve.go`）：按"覆盖密度/成本"排序逐个测试决策；
  排除分支将测试加入禁用集，前置闭包与禁用集相交时剪枝，保证每个闭子集
  只生成一次。下界（可采纳）：
  - 成本：各未覆盖需求的最便宜可用覆盖者成本的最大值，以及
    `ceil(Σ 最便宜覆盖成本 / K)`（K 为单测试最多可新覆盖需求数）；
  - 数量：`ceil(未覆盖需求数 / K)`；
  - 时间：各未覆盖需求的最快可用覆盖者时间的最大值，用于时限剪枝。
- **贪心**（同文件）：搜索前构造初始 incumbent 加速剪枝。
- **穷举**（`solver/exhaustive.go`）：独立枚举全部 2^n 子集，用于小实例
  核对（`TestBranchBoundVsExhaustive`，400 个随机实例，n≤14）。

## 覆盖证书与最优搜索界

证书（`solver/cert.go`）包含：选中测试、总成本/数量/时间、每个需求的
见证测试（覆盖证书）、以及分支定界证明的下界（最优搜索界）。
`status=OPTIMAL` 时下界与目标值相等，即最优性的可检验证明；
`VerifyCertificate` 会重算闭包、时限、见证并重跑求解器确认目标值与界。

## 测试

```sh
go test ./...
```

实际运行结果（go1.27.1 linux/amd64）：

```
ok  	testplan	0.004s
ok  	testplan/solver	0.123s
```

覆盖：400 个随机小实例的分支定界 vs 穷举核对、6 个手工已知最优实例、
证书篡改拒绝、输入校验（>24 测试、重复 id、未知前置/分支、负成本）、
节点预算路径、24 测试规模实例求解。
