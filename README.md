# joinopt — 连接顺序优化器（至多 12 表）

在**已定义连接边**上规划二叉连接树，使总中间成本最小，输出唯一**规范树序**、
每个连通子树的**估算证书**，并可用**全枚举**核对小实例。仅使用 Go 标准库。

## 问题模型

- 表数 `1 ≤ n ≤ 12`，每表 `i` 有正整数基数 `card_i`。
- 每条已定义连接边 `{i,j}` 显式携带整数中间基数 `j_ij`（两表连接结果 `i ⋈ j` 的
  估算行数），须满足 `1 ≤ j_ij ≤ card_i · card_j`。
- 边选择率为有理数 `sel(i,j) = j_ij / (card_i · card_j)`；所有估算与成本用
  `math/big.Rat` 精确计算，无浮点误差。
- 子计划 `A`、`B` 连接的估算输出：`est(A)·est(B)·∏ sel`（乘积取遍跨越 `A|B`
  割的已定义边）。因此任意子集 `S` 的估算与计划无关：
  `est(S) = ∏ card_i · ∏ sel`（后者取遍 `S` 内部的边）——这就是每子树证书中的
  估算基数。
- **成本规则**：计划总成本 = 所有内部（连接）节点的 `est` 之和，即中间结果总量。
- **约束**：只允许二叉树，且每个连接节点的两侧之间至少有一条已定义边
  （禁止笛卡尔积）。连接图不连通时不存在合法计划，CLI 以退出码 1 报告。
- **规范树序**：每个连接节点的两个孩子按其规范串字典序排列；同成本计划之间
  取规范串最小者。因此最优计划唯一、可复现。

## 算法

- 主求解器：连通子集上的子集 DP（`solve.go`）。对每个连通子集枚举含最低位的
  二划分，两侧均连通且割上有边时转移，按 `(成本, 规范串)` 取最小。
  复杂度 `O(3^n)`，`n=12` 时约 50 万个子集划分。
- 独立核对：逐叶按固定顺序插入的全枚举（`brute.go`），恰好生成 `(2n−3)!!`
  棵无序二叉树，自底向上求值并过滤违反边约束的树。与 DP 共享成本模型但不共享
  搜索结果，用于小实例（`n ≤ 9`）对拍。

## CLI

```sh
go run ./cmd/joinopt [-input file.json] [-verify] [-no-certificates]
```

- `-input`：JSON 输入文件，缺省 `-` 表示标准输入。
- `-verify`：枚举全部二叉连接树核对 DP 最优解（限 `n ≤ 9`）。
- `-no-certificates`：不打印证书表。

退出码：`0` 成功；`1` 无合法计划或核对失败；`2` 输入/参数错误。

输入格式（边端点可用 0 起始下标或表名）：

```json
{
  "tables": [{"name": "A", "card": 100}, {"name": "B", "card": 200}],
  "edges": [{"a": "A", "b": "B", "card": 1000}]
}
```

输出：最优成本、规范计划、连接顺序（每步估算与子树成本）、每个连通子树的
证书（表集合、精确估算基数、最优成本、规范计划）。

## 示例

`go run ./cmd/joinopt -verify -input example.json` 实际输出：

```
tables: 4
edges: 3

optimal cost: 41800
canonical plan: ((A ⋈ B) ⋈ (C ⋈ D))

join order:
  1.  A ⋈ B              -> est 1000   subtree cost 1000
  2.  C ⋈ D              -> est 800    subtree cost 800
  3.  (A ⋈ B) ⋈ (C ⋈ D)  -> est 40000  subtree cost 41800

certificates (every connected subtree):
  tables        est    best cost  best plan
  {A}           100    0          A
  {B}           200    0          B
  {C}           50     0          C
  {D}           400    0          D
  {A, B}        1000   1000       (A ⋈ B)
  {B, C}        500    500        (B ⋈ C)
  {C, D}        800    800        (C ⋈ D)
  {A, B, C}     2500   3000       ((B ⋈ C) ⋈ A)
  {B, C, D}     8000   8500       ((B ⋈ C) ⋈ D)
  {A, B, C, D}  40000  41800      ((A ⋈ B) ⋈ (C ⋈ D))

verification: enumerated 15 binary trees, 5 satisfy the edge constraint
verification: PASS (exhaustive enumeration agrees with DP)
```

## 测试

测试覆盖：手算链式/三角样例、估算公式、枚举树计数 `(2n−3)!!`、40 个随机
实例（`n=2..7`）上 DP 与全枚举对拍、不连通图、输入校验、CLI 端到端
（含 `-verify`）。

`go test ./...` 实际结果（go1.27.1 linux/amd64，2026-10-05）：

```
ok  	joinopt	0.377s
?   	joinopt/cmd/joinopt	[no test files]
```

全部 12 个测试通过（`go test -v`：TestEstimationFormula、
TestHandComputedOptimum、TestEnumerationCount、TestDPvsBruteForceRandom、
TestDisconnectedGraph、TestSymmetricTriangleCanonical、TestPlanInvariants、
TestValidationErrors、TestParseJSON、TestRunCLI、TestRunCLIDisconnected、
TestRunCLIBadInput 均 PASS）。

## 文件

- `problem.go` — 问题定义、JSON 解析与校验
- `solve.go` — 连通子集 DP、规范计划、证书
- `brute.go` — 独立全枚举核对
- `cli.go` / `cmd/joinopt/main.go` — 命令行入口
- `joinopt_test.go` — 测试
- `example.json` — 示例输入
