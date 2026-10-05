# vehicle-planner 车辆规划库

TypeScript 实现，仅依赖 Node.js 内置模块（编译期使用 `typescript`，运行期零依赖）。

## 问题模型

- 输入：车辆初始点（`vehicles[].startPoint` / `availableTime`）、至多 **14** 个订单、
  点间行驶时间矩阵 `travelTime`（既用于空驶，也用于订单取送在途）。
- 每个订单：`pickup` → `delivery`，`readyTime` 后才能开始装货，装货 `serviceTime`，
  送达时刻不得超过 `deadline`，完成收益 `revenue`。
- 每单至多由一辆车完成；车辆路线中相邻订单的时间衔接包含空驶
  （上一单送货点 → 下一单取货点，取 `travelTime`）。
- 目标：**总收益 − 空驶费**（空驶时间 × `emptyCostPerUnitTime`）最大。
- 并列规则：按订单分配序列取字典序最小——按订单编号顺序比较，
  车辆编号小者优先，“未分配”视为最大编号（即分配优于不分配）。
  实现上将分配向量编码为基 `V+1` 的 BigInt（订单 0 为最高位），见 `src/key.ts`。

## 算法

1. 单车子集 DP（`src/solver.ts`）：状态 `(S, i)` 表示一车恰好服务集合 `S` 且末单为 `i`，
   每个状态保存 `(完成时刻, 净收益)` 的 Pareto 前沿，保证时间窗可行性不被贪心破坏。
2. 车辆组合 DP：`f[v][S]` 为前 `v` 辆车恰好覆盖 `S` 的最优 `(目标值, 并列编码)`，
   两者对子集均可加、按字典序比较，可分解合并；复杂度约 `O(V · 3^n)`，n ≤ 14。
3. 输出**路线证书**（`Certificate`）：每车的订单序列、各段空驶/到达/服务/送达时刻、
   收益与空驶费汇总、分配向量。

## 独立核对

- `verifyCertificate`（`src/verify.ts`）：不依赖求解器内部状态，按输入对证书逐步
  正向模拟，校验时间衔接（含空驶）、时间窗、每单至多一车及全部汇总字段。
- `bruteForceSolve`（`src/brute.ts`）：独立枚举——枚举全部 `(V+1)^n` 种分配 ×
  每车订单集合的全排列模拟，用于小规模交叉验证最优性与并列规则。

## 使用

```bash
npm test          # 编译 + 运行全部测试（tsc && node --test）
npm run build     # 仅编译到 dist/
```

```ts
import { solve, verifyCertificate } from "./src/index";
const cert = solve(input);                 // 路线证书
const check = verifyCertificate(input, cert); // { ok, errors }
```

## 测试与实际结果

测试（`test/solver.test.ts`）覆盖：手工已知最优算例、时间窗不可行不分配、
空驶费过高不接单、两种并列规则场景、编码序性质、证书篡改检测、
60 例随机小规模与独立枚举逐位比对（目标值与分配序列完全一致）、
14 订单 3 车规模上限。

最近一次在本机（Node v22.22.1，tsc 7.0.2）执行 `npm test` 的实际结果：

```
9 个用例全部通过（pass 9 / fail 0），总耗时约 0.6s；
其中 14 订单 3 车求解耗时约 200ms；
另做一次性 300 例随机交叉验证（n≤8, V≤4）：0 例不一致。
```
