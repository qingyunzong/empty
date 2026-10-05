# assign-cli

把至多 12 张工单一对一分配到等量工位，求最低总费用。支持禁配（`null`/`"x"`）与负费用。
输出最小费用、匹配 ID 序列与**对偶证书**；不可行时输出 **Hall 见证**。
内置**独立验证器**（每次求解后自动校验证书）与**排列枚举核对**（`--brute`）。

仅使用 Node.js 内置模块，无任何 npm 依赖。

## 输入格式

JSON 文件（或 `-` 表示标准输入）：

```json
{
  "orders":   ["W1", "W2", "W3", "W4"],
  "stations": ["S1", "S2", "S3", "S4"],
  "costs": [
    [5, null, 2, 7],
    [3, -1, 4, null],
    [null, 2, 1, 6],
    [8, 3, null, -2]
  ]
}
```

- `orders` / `stations`：1..12 个唯一 ID，数量必须相等；
- `costs[i][j]`：工单 i 配到工位 j 的费用（可为负）；`null` 或 `"x"` 表示禁配。

## 用法

```bash
npm start -- examples/feasible.json --brute   # 求解 + 枚举核对
npm start -- examples/infeasible.json         # 不可行：打印 Hall 见证
npm start -- - --json < input.json            # 标准输入 + JSON 输出
npm test                                      # 编译并运行全部测试
npm run typecheck                             # 严格类型检查
```

退出码：`0` = 已求最优，`2` = 不可行（附 Hall 见证），`1` = 输入或内部错误。

## 方法

- **求解**（`src/solver.ts`）：经典 O(n³) 匈牙利算法，直接支持负费用。
  禁配边以大 M（= 2Σ|c| + 1）填充：只要允许边的完美匹配存在，最优解必不含禁配边，
  且匈牙利算法给出的对偶势 `u, v` 对所有允许边满足 `u[i]+v[j] ≤ c[i][j]`，即为对偶证书。
  求解前先用增广路最大匹配判定可行性。
- **Hall 见证**：不可行时，从未匹配行做交错 BFS，得到行集 S 满足 |N(S)| < |S|（Hall 定理）。
- **独立验证器**（`src/verifier.ts`）：不复用求解器逻辑，仅从原理重检——
  匹配是合法排列、无边禁配、费用一致；对偶可行性、匹配边互补松弛、对偶目标值 = 原始费用；
  或对 Hall 见证独立重算 N(S) 并验证 |N(S)| < |S|。
- **排列枚举**（`src/bruteforce.ts`）：带剪枝的全排列枚举（n ≤ 10），
  剪枝下界为“剩余行最小允许费用之和”，对负费用依然正确。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：

```
ok 1 - dist/test/cli.test.js
ok 2 - dist/test/solver.test.js
ok 3 - dist/test/verifier.test.js
# tests 3
# pass 3
# fail 0
```

测试覆盖：固定正例/负费用/禁配/不可行用例、300 组随机实例（n≤8，费用 ∈ [-20,20]）
与排列枚举逐一核对、验证器对篡改匹配/费用/对偶/伪造 Hall 见证的拒绝、CLI 端到端
（含退出码、stdin、JSON 输出、非法输入）。

`npm start -- examples/feasible.json --brute`（退出码 0）：

```
status: optimal
cost: 3
assignment:
  W1 -> S1 (cost 5)
  W2 -> S2 (cost -1)
  W3 -> S3 (cost 1)
  W4 -> S4 (cost -2)
dual certificate:
  u = [5, 1, 4, -2]
  v = [0, -2, -3, 0]
verification: ok
brute force: agrees (1 permutations examined)
```

`npm start -- examples/infeasible.json`（退出码 2）：

```
status: infeasible
hall witness: orders {W1, W2} connect only to stations {S1}
  |N(S)| = 1 < |S| = 2
verification: ok
```

## 环境备注

- 本机 Node 构建不含类型剥离（`--experimental-strip-types` 不可用），故 `npm test`/`npm start`
  先用全局 `tsc` 编译到 `dist/` 再运行。
- 本环境 `spawnSync` 无法向子进程管道传 stdin，CLI 的 stdin 测试经由临时文件 + shell 重定向完成；
  CLI 输出一律用 `fs.writeSync` 同步写，避免管道缓冲丢失。
