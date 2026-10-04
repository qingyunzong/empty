# 巡检路线 CLI（带时间窗的定向问题 OPTW，精确求解）

巡检车从基地出发并返回，至多 16 个候选站点，每站有服务时间、时间窗与收益，
允许跳过任何站点。整数总时限 60（行驶 + 等待 + 服务，含返回基地）。
目标按字典序：**总收益最大优先，总路程最小次之**。
仅使用 TypeScript + Node.js 内置库，零运行时依赖。

## 规则

- 节点 0 为基地，0 时刻出发；行驶时间 = 欧氏距离（速度 1）。
- 到达早于 `open` 需等待；开始服务晚于 `close` 则该站不可服务。
- 总耗时 = 末站离开时刻 + 返回基地行驶时间，须 `<= timeLimit`（60）。

## 使用

```bash
npm run build                                  # tsc 编译到 dist/
node dist/cli.js solve  instances/demo.json    # 求解并打印到离时刻证书
node dist/cli.js solve  instances/demo.json --json --out cert.json
node dist/cli.js verify instances/demo.json cert.json   # 独立校验证书
node dist/cli.js check  instances/small.json   # 小图穷举交叉验证（n <= 10）
npm test                                       # 编译并运行全部测试
```

实例 JSON 格式见 `instances/demo.json`：`timeLimit`、`depot{x,y}`、
`stations[{id,x,y,service,open,close,profit}]`。

## 算法

- **求解器**（`src/solver.ts`）：子集 DP + Pareto 标签。状态 `(mask, last)`
  保留互不支配的 `(完成服务时刻, 累计路程)` 标签，逐站扩展，最后接返回基地
  按时限过滤，以 `(收益降, 路程升, 时间升)` 选优。n ≤ 16 时精确可解。
- **穷举验证器**（`src/brute.ts`）：枚举所有站点子集的所有排列并模拟计时，
  仅用于小图（n ≤ 10）交叉验证最优性。
- **证书**（`src/certificate.ts`）：记录每站到达/等待/开始服务/离开时刻，
  `verify` 只依据证书中的站点顺序独立重算全部时刻并核对窗口、时限、收益、路程。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`node dist/cli.js solve instances/demo.json`（10 站，时限 60）：

```
实例: demo-10站    时限: 60
收益: 25    路程: 41.09    总耗时: 54.09
到离时刻证书:
  节点        到达      等待  开始服务      离开  时间窗            收益
  BASE         0.00     0.00     0.00     0.00  -                  -
  S1           6.32     0.00     6.32     9.32  [0.00, 25.00]      6
  S2          16.54     0.00    16.54    20.54  [8.00, 30.00]      9
  S6          34.68     0.00    34.68    40.68  [0.00, 50.00]      10
  BASE        54.09     0.00    54.09    54.09  -                  -
```

`node dist/cli.js check instances/demo.json`（穷举 10 站全部有序子集，约 4.3s）：

```
DP 求解:   收益 25, 路程 41.0942, 路线 S1 -> S2 -> S6
穷举验证:  收益 25, 路程 41.0942, 路线 S1 -> S2 -> S6
一致: 最优性通过穷举验证
```

`node dist/cli.js verify instances/demo.json cert.json`：

```
证书有效: 收益 25, 路程 41.094201, 总耗时 54.094201 / 60
```

`npm test`（node:test，8 个用例全部通过）：

```
✔ 手工小例：远站被时限排除，只访问近站
✔ 并列收益时选路程更小的方案
✔ 时间窗等待计入总耗时
✔ 到达晚于 close 的站点不可服务
✔ 小图穷举验证：40 个随机实例 DP 与穷举一致
✔ 证书校验：合法证书通过，篡改证书被识破
✔ 16 站上限：求解可行且不超时限
✔ 超过 16 站拒绝求解
ℹ tests 8  ℹ pass 8  ℹ fail 0
```
