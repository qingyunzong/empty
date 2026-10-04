# assign-cli — 工单-工位最低费用一对一分配

将至多 12 个工单一对一分配给等量工位，支持禁配与负费用。
输出最低费用与匹配 ID 序列，并给出**对偶证书**（最优性证明）或
**Hall 见证**（不可行证明），附带独立验证器与排列枚举/子集 DP 双重核对。
纯 TypeScript + Node.js 内置库，零运行时依赖。

## 使用

```bash
npm run build                 # tsc 编译到 dist/
node dist/src/cli.js <input.json> [--check] [--brute]
npm test                      # 编译并运行全部测试
```

退出码：`0` 求得最优解；`3` 不可行（已输出 Hall 见证）；`1` 输入或校验错误。

## 输入格式

```json
{
  "orders":   ["W1", "W2"],
  "stations": ["S1", "S2"],
  "costs":    [{ "order": "W1", "station": "S1", "cost": -3 }, ...],
  "forbidden": [["W1", "S2"]]
}
```

- `orders` / `stations`：等长 ID 数组，1 ≤ n ≤ 12。
- 费用二选一：`costs`（逐条 `{order, station, cost}`，须覆盖所有非禁配对）
  或 `costMatrix`（n×n 矩阵）。费用可为负。
- `forbidden`：禁配 `[orderId, stationId]` 列表。

## 输出

- **最优**：`cost`、`matching`（工单→工位 ID 序列）、`dualCertificate`
  （u、v 满足：所有允许对 u_i+v_j ≤ c_ij，匹配边取等号，Σu+Σv = 总费用——强对偶即最优性证明）。
- **不可行**：`hallWitness`，工单子集 S 满足 |S| > |N(S)|（Hall 条件被破坏，故无完美匹配）。
- `verification`：独立验证器（`src/verify.ts`，不复用求解逻辑）逐项复检结果。
- `--check`：追加子集 DP 核对；`--brute`：追加排列枚举核对（n ≤ 10）。

## 方法

- 求解：匈牙利算法 O(n³)，禁配边置大 M（M = 2n·(max|c|+1)+1，保证任何可行
  完美匹配优于任何含禁配边的匹配）；允许负费用。
- 不可行时：最大流 + 残余图中源点可达工单集 S，即 Hall 见证。
- 核对器一：排列枚举（带“剩余行最小费用和”下界剪枝，对负费用安全）。
- 核对器二：子集位掩码 DP，O(2ⁿ·n²)。

## 实测结果（本机 Node v22.22.1）

`npm test` 输出：

```
ok 1 - handcrafted: negative costs, known optimum
ok 2 - handcrafted: forbidden forces detour
ok 3 - handcrafted: infeasible with Hall witness
ok 4 - handcrafted: fully forbidden
ok 5 - handcrafted: n = 1
ok 6 - randomized: solver vs permutation enumeration + DP, n <= 8   (300 个随机实例)
ok 7 - randomized: n = 12 vs DP cross-check                          (40 个随机实例)
ok 8 - randomized: all-negative costs, n = 12                        (10 个随机实例)
ok 9 - CLI end-to-end on examples # SKIP sandbox blocks child processes
ok 10 - input validation
# tests 10
# pass 9
# fail 0
# skipped 1
```

（测试 9 在本沙箱内因子进程限制被跳过；CLI 已在 shell 中手动验证，见下。）

CLI 手动验证：

- `node dist/src/cli.js examples/feasible.json --check --brute` →
  `status: optimal, cost: -2`，匹配 W1→S2, W2→S3, W3→S4, W4→S1；
  对偶证书通过强对偶校验（Σu+Σv = -2）；DP 与排列枚举核对均为 -2；退出码 0。
- `node dist/src/cli.js examples/infeasible.json` →
  `status: infeasible`，Hall 见证 S={A,B,C}, N(S)={W,X}, |S|=3 > |N(S)|=2；退出码 3。
