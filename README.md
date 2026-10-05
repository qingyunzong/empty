# vehicle-planner 车辆规划库

接收**车辆初始点**、**至多 14 个订单**与**空驶时间矩阵**，在"每单至多由一车完成、
时间衔接含空驶"的约束下，求**总收益 − 总空驶费最大**的分配与路线，输出可独立核对的
**路线证书**，并附带**独立全枚举核对器**交叉验证最优性。

纯 TypeScript + Node.js 内置库（`node:test` / `node:assert`），零运行时依赖。

## 问题模型

- `Order`：`location`（地点）、`readyTime`/`dueTime`（服务**开始**时刻时间窗）、
  `duration`（服务时长）、`revenue`（收益）。
- `Vehicle`：`startLocation`（初始点）、`availableTime`（可用时刻）、
  `costPerUnitTime`（单位空驶时间费用）。
- `emptyTime`：地点间空驶时间方阵（允许非对称；绕行可能快于直达）。
- 衔接规则：到达时刻 = 上一单完成时刻 + 空驶时间；早于 `readyTime` 则等待
  （等待不计费）；开始时刻超过 `dueTime` 则该衔接不可行。路线为开放式（不回场）。
- 每单至多由一车完成，允许放弃订单（如负利润或不可行）。

## 最优性与并列规则（规范全序）

1. **利润**（总收益 − 总空驶费）高者优先；
2. 利润并列时**按订单分配序**：分配向量（按订单输入序，元素为车辆下标，未分配
   取哨兵 = 车辆数）字典序小者优先——即靠前订单"已分给小号车"优于"未分配"；
3. 再并列时各车路线（订单下标序列）按车辆序号依次字典序小者优先。

求解器与枚举器遵循同一全序，因此最优解唯一确定、可逐位比对。

## API（`src/index.ts`）

- `solvePlan(input): PlanCertificate` — 精确求解器。单车子集 DP
  （`(mask, last)` 上维护 `(完成时刻, 空驶)` 帕累托前沿）+ 跨车子集卷积，
  复杂度约 `O(V·3^n + V·2^n·n²)`，n ≤ 14。
- `bruteForcePlan(input): PlanCertificate` — 独立枚举核对器。枚举
  `(V+1)^n` 种分配 × 每车订单集合的全排列，与求解器不共享搜索代码
  （建议 n ≤ 10）。
- `verifyCertificate(input, cert): string[]` — 独立核对证书：重算每条路线的
  时间衔接（含空驶）、每单至多一车、分配一致性与总账；返回错误列表，空为有效。
- `validateInput` / `simulateRoute` / `MAX_ORDERS` 等辅助导出。

`PlanCertificate` 含：`profit`、`totalRevenue`、`totalEmptyCost`、
`assignment`（每单 → 车辆下标或 `null`）、`routes`（每车的停靠点时间线：
空驶段、到达/开始/完成时刻及分车账目）。

## 运行测试

```sh
npm test   # = tsc -p tsconfig.json && node --test dist/test/*.test.js
```

需要本机可用的 `tsc`（TypeScript）与 Node.js ≥ 18；无需 npm install。

## 实际测试结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 实际输出摘要：**3 个测试文件全部通过，共 20 个用例，0 失败**。

```
# tests 3   （文件级：bruteforce / solver / verify）
# pass 3
# fail 0
# duration_ms 17148.7
```

各文件明细（`node dist/test/<file>` 实跑）：

- `solver.test.js`：11/11 通过。覆盖空驶衔接排序、等待不计费、dueTime 放弃、
  两组并列分配序、负利润放弃、空输入、每单至多一车、多车分工、>14 单抛错、
  14 单 2 车冒烟（实测求解 240ms，利润 108，证书核对通过）。
- `bruteforce.test.js`：3/3 通过。120 个随机算例（n≤8, V≤3）+ 5 个 n=10 算例
  + 60 个并列构造算例，DP 求解器与独立全枚举**逐位一致**（利润、分配、路线）。
- `verify.test.js`：6/6 通过。合法证书通过；篡改利润/到达时间/重复服务/
  分配不一致/违反 dueTime 均被检出。

对拍过程中实际发现并修复两处缺陷，体现了独立枚举核对的价值：

1. 求解器帕累托支配规则在空驶相等时误丢字典序更小路径（并列路线不唯一）；
2. 枚举器曾按"中间子集不可行"剪枝，但非对称矩阵下绕行可使超集转可行。
