# transfer-cli

有向账户图上的最小费用转账 CLI。从源账户向目标账户发送**至多 20 的整数单位**，
边带容量与**分段线性费用**（每段：容量 + 单位费率，费率可负，但输入禁止负费用环）。
输出最小费用流、逐边流量，以及**残量势能最优性证书**；小网络可用内置暴力枚举核对。

仅使用 TypeScript + Node.js 内置模块（`node:fs`、`node:test`、`node:assert`、
`node:child_process`），零运行时依赖。环境无 `@types/node`，
`src/node-shims.d.ts` 提供所需的最小类型声明。

## 构建与测试

```sh
npm run build   # tsc -> dist/
npm test        # 构建并运行 node:test 测试
npm start -- examples/sample.json --brute
```

## 用法

```
transfer <input.json | -> [--amount N] [--brute]
```

- 输入为 JSON（文件或 `-` 表示 stdin），格式见下；`amount` 为 0..20 的整数，
  可用 `--amount` 覆盖。
- `--brute` 对小网络（枚举空间 ≤ 5,000,000）用全枚举独立核对最小费用。
- 退出码：`0` 求得最优流；`1` 请求量不可行；`2` 输入非法（含负费用环）。

输入格式（`segments` 费率必须非递减，即凸分段费用）：

```json
{
  "source": "alice",
  "sink": "dave",
  "amount": 5,
  "edges": [
    { "from": "alice", "to": "bob",
      "segments": [ { "capacity": 2, "cost": -1 }, { "capacity": 3, "cost": 2 } ] }
  ]
}
```

## 算法

1. **分段展开**：每条边的每个费用段展开为一条（容量, 单位费率）弧。
   凸费率（非递减）保证该展开与原分段费用模型等价。
2. **负环检测 + 初始势能**：从虚拟超级源（到所有点 0 费用）跑 Bellman-Ford。
   第 n 轮仍可松弛 ⇒ 输入含负费用环，拒绝（退出码 2）；否则得到
   满足 `h[v] <= h[u] + c(u,v)` 的势能，所有残余弧约化成本非负。
3. **连续最短路（SSP）**：每轮在约化成本上跑 Dijkstra，沿最短路增广
   整数瓶颈量，并更新势能，直到送满 `amount` 或汇点不可达（不可行）。
   容量与流量均为整数，故结果流量为整数。
4. **证书势能**：在**最终残余图**上重新跑一次超级源 Bellman-Ford，得到
   势能 `pi`，使每条残余弧满足 `c(u,v) + pi(u) - pi(v) >= 0`
   （SSP 内部势能只在源可达点集上维护，故证书势能独立重算）。

## 最优性证书

输出的 `certificate` 含三项校验，全部通过即 `valid: true`：

- `capacity`：每段弧 `0 <= flow <= capacity`；
- `conservation`：源净流出 = 目标净流入 = `amount`，其余节点收支平衡；
- `reduced-costs`：每条残余弧（正向剩余容量 > 0 或反向流量 > 0）满足
  `c(u,v) + pi(u) - pi(v) >= 0`。

由第三条：任意同流量可行流的费用与本流之差等于其在残余图上的约化成本
（非负），故本流费用最小——势能 `pi` 即最优性的可验证证书。

## 示例

`npm start -- examples/sample.json --brute` 的实际输出（节选）：

```json
{
  "status": "ok",
  "amount": 5,
  "minCost": 14,
  "flows": [
    { "from": "alice", "to": "bob",   "flow": 3, "cost": 0 },
    { "from": "alice", "to": "carol", "flow": 2, "cost": 6 },
    { "from": "bob",   "to": "dave",  "flow": 3, "cost": 6 },
    { "from": "carol", "to": "dave",  "flow": 2, "cost": 2 }
  ],
  "potentials": { "alice": -4, "dave": 0, "bob": -2, "carol": -1 },
  "certificate": { "valid": true, "checks": [ ... ] },
  "bruteForce": { "status": "ok", "minCost": 14, "agreesWithSolver": true }
}
```

## 测试结果实录

`npm test`（Node v22.22.1，tsc 7.0.2）实际运行结果：

```
# Subtest: dist/test/cli.test.js
ok 1 - dist/test/cli.test.js
# Subtest: dist/test/solver.test.js
ok 2 - dist/test/solver.test.js
# tests 2
# pass 2
# fail 0
```

求解器测试（8/8 通过）：

```
ok 1 - classic network, amount 2 -> cost 8
ok 2 - piecewise fees: convex segments are priced per segment
ok 3 - negative fees without negative cycles
ok 4 - amount 0 is trivially optimal
ok 5 - infeasible amount reported
ok 6 - negative-cost cycle in input is rejected
ok 7 - non-convex segments rejected at parse time
ok 8 - 400 random small networks agree with enumeration
  [random] solved=183 infeasible=48 skippedNegativeCycle=169
```

CLI 端到端测试（5/5 通过）：样例求解 + 证书校验、stdin 与 `--amount` 覆盖、
不可行退出码 1、负环退出码 2、非法输入退出码 2。

随机核对说明：固定种子（mulberry32, seed=20261005）生成 400 个 4–5 节点、
费率 ∈ [-4, 8] 的凸分段小网络；169 个因含负环被合法拒绝，其余 231 个
（183 可行 / 48 不可行）的最小费用与状态全部与暴力枚举一致，且每个可行解的
证书均通过验证。暴力枚举利用"无负环 ⇒ 存在各边流量 ≤ amount 的最优解"
将枚举上界剪到 `min(capacity, amount)`。

## 目录结构

- `src/model.ts` — 输入模型、JSON 校验（含凸性检查）、分段费用计算
- `src/solver.ts` — 分段展开、负环检测、SSP 最小费用流、证书势能与校验
- `src/brute.ts` — 小网络全枚举核对器
- `src/cli.ts` — 命令行入口（JSON 输入输出、退出码）
- `test/` — 固定用例 + 随机对拍 + CLI 端到端
- `examples/` — 样例输入（含一个负环反例）
