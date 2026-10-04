# patrol-cli 巡检路线 CLI

从基地（BASE）出发并返回的巡检路线规划：至多 16 个站点，每站有服务时间、
时间窗与收益，允许跳过任意站点；整数总时限 60（行驶 + 等待 + 服务）。
目标：**先总收益最大，并列时总路程最小**。

仅使用 TypeScript + Node.js 内置库（`node:fs` / `node:path` / `node:test` /
`node:assert`），无任何第三方运行时依赖。

## 用法

```bash
npm test          # 编译 + 运行全部测试（node:test）
npm start         # 求解 data/instance.json 并做子集 DP 交叉验证
node dist/src/cli.js data/instance.json            # 输出到离时刻证书
node dist/src/cli.js data/instance.json --verify   # 附加独立 DP 求解器对拍
node dist/src/cli.js data/small.json --json        # JSON 格式证书
```

## 模型

- 站点坐标 (x, y)，行驶时间 = 路程 = 欧氏距离四舍五入取整（对称整数矩阵）。
- 到达早于时间窗开放则等待；服务开始时间必须落在 `[open, close]` 内。
- t=0 从基地出发，返回基地时刻必须 ≤ 60。

## 求解与验证

- `src/solver.ts`：分支限界（利润上界 + 路程并列剪枝）精确求解。
- `src/dp.ts`：独立的子集 DP（Pareto 标签 `(离开时刻, 路程)`）精确求解，用于交叉验证。
- `src/brute.ts`：小图穷举全部「子集 × 排列」路线，作为真值对拍。
- `src/certificate.ts`：生成到/离时刻证书，并可独立重算校验（窗口、时限、
  收益、路程、到离时刻逐项核对，拒绝篡改）。

## 实际运行结果（已记录）

`npm test`（Node v22.22.1, tsc 7.0.2）——7 个用例全部通过
（`node --test` 汇总显示为文件级 `pass 1 / fail 0`，用例明细如下）：

```
# Subtest: small graph: branch-and-bound matches exhaustive route enumeration     ok
# Subtest: small graph: subset-DP matches exhaustive route enumeration            ok
# Subtest: main 16-station instance: branch-and-bound matches independent DP      ok
# Subtest: certificate: valid, self-consistent, respects windows and limit        ok
# Subtest: certificate: validator rejects tampered certificates                   ok
# Subtest: certificate: infeasible routes are rejected at build time              ok
# Subtest: degenerate instances: no reachable station yields the empty route      ok
# tests 7 / pass 7 / fail 0
```

主实例 `data/instance.json`（16 站）求解输出（约 4 ms）：

```
Instance: patrol-16   time limit: 60
Route: BASE -> S01 -> S11 -> S04 -> BASE

STATION   ARR   WAIT  SERVE  DEP   WINDOW      PROFIT
S01       9     0     9      12    [5, 25]     10
S11       22    0     22     25    [8, 32]     12
S04       31    0     31     36    [15, 40]    18

Return to BASE at t=59 (limit 60)
Total profit:   40
Total distance: 48
Total time:     59

Certificate self-check: OK
Cross-check vs independent subset-DP solver: OK (profit=40, distance=48)
```

小图 `data/small.json`（6 站，穷举对拍一致）：

```
Route: BASE -> A -> B -> E -> BASE
A  arr 5  serve 5  dep 7   window [3, 20]  profit 8
B  arr 14 serve 14 dep 17  window [8, 25]  profit 10
E  arr 28 serve 28 dep 30  window [12, 28] profit 9
Return at t=43 | profit 27 | distance 36 | total time 43
```
