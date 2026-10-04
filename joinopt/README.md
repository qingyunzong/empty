# joinopt

连接顺序规划器：对至多 12 张表，在**仅允许已定义连接边的二叉树**约束下，
求总成本最小的连接树，输出规范树序与每子树估算证书。仅使用 Go 标准库。

## 成本模型（明确整数规则）

- 每张表 `i` 有正整数基数 `c_i`；每条连接边 `(u,v)` 有显式整数除数 `d_uv >= 1`（选择率分母）。
- 子集 `S` 的估算基数（大整数精确计算后一次向下取整）：

  ```
  estCard(S) = max(1, floor( prod_{i in S} c_i / prod_{(u,v) in E(S)} d_uv ))
  ```

  其中 `E(S)` 为两端都在 `S` 内的边。
- 一棵二叉连接树的总成本 = 所有内部节点（含根）输出基数 `estCard` 之和；
  叶节点成本为 0。
- 合法性：每个内部节点的两个子集之间至少存在一条已定义连接边
  （蕴含两个子集各自连通）。

## 求解与规范树序

- 子集 DP（`2^12 = 4096` 个子集）：`cost(S) = estCard(S) + min(cost(A)+cost(B))`，
  枚举所有满足跨边约束的二分 `A | B`。
- 规范树序：每个内部节点的两棵子树按字符串字典序排列，形如 `(L R)`；
  同成本时取规范串字典序最小者，保证输出唯一确定。

## 输入格式（stdin）

```
<n>                表数，1..12
<name> <card>      共 n 行：表名与正整数基数
<m>                边数
<name> <name> <d>  共 m 行：边的两个端点与整数除数 d >= 1
```

## 输出

- `Optimal total cost`：最小总成本。
- `Canonical tree order`：规范树序，如 `((A B) (C D))`。
- `Per-subtree estimation certificate`：每个连通子集的估算基数、最小成本、
  最优划分（可由划分自底向上重建规范树，见 `TestCertificateReconstructsTree`）。
- `-verify`：对 `n <= 8` 暴力枚举全部 `(2n-3)!!` 棵合法二叉树交叉核对，
  不一致则以非零码退出。

## 示例

```
$ printf '4\nA 10\nB 20\nC 30\nD 40\n3\nA B 2\nB C 3\nC D 5\n' | ./joinopt -verify
Optimal total cost: 8340
Canonical tree order: ((A B) (C D))
Per-subtree estimation certificate:
  subset                   est-card       min-cost       split
  {A}                      10             0              -
  ...
  {A, B, C, D}             8000           8340           {A, B} | {C, D}
Verify: exhaustive enumeration agrees (cost 8340 , tree ((A B) (C D)))
```

12 表、25 边实例实测约 0.03s。

## 测试

`go test ./...` 实际运行结果（2026-10-05，go1.27.1 linux/amd64）：

```
=== RUN   TestSolveChain3                  --- PASS (手算 3 表链)
=== RUN   TestSolveChain4Bushy             --- PASS (手算 4 表链，bushy 最优)
=== RUN   TestCanonicalTieBreak            --- PASS (对称图规范序)
=== RUN   TestEstCardFloorAndMinOne        --- PASS (取整与下限规则)
=== RUN   TestDisconnectedRejected         --- PASS (不连通图报错)
=== RUN   TestSingleTable                  --- PASS (单表边界)
=== RUN   TestDPvsBruteForceRandom         --- PASS (n=2..8 共 178 个随机图，
                                                    DP 与暴力枚举逐连通子集
                                                    核对成本、规范树、估算基数)
=== RUN   TestReadProblem                  --- PASS (输入解析与非法输入)
=== RUN   TestCertificateReconstructsTree  --- PASS (证书划分可重建规范树)
PASS
ok  	joinopt	0.088s
```
