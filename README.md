# 温控模拟库（thermostat-sim）

基于精确有理数运算的温控（加热器启停）模拟库。TypeScript 编写，仅使用 Node.js
内置模块（`node:test` / `node:assert`），无任何运行时依赖。

## 模型

- **外部温度** `E(t)`：由折点定义的分段线性函数（`PiecewiseLinear`），定义域外按
  端段斜率外延。
- **室温演化**：加热器关闭时 `dT/dt = E'(t)`；开启时 `dT/dt = E'(t) + h`，其中
  `h` 为恒定加热速率。室温轨迹因此始终分段线性，所有事件时间保持为有理数。
- **启停阈值（滞回）**：`tempOn < tempOff`。关闭状态下 `T <= tempOn` 时开启；
  开启状态下 `T >= tempOff` 时关闭。阈值恰达按**闭区间**处理（`<=` / `>=`，
  恰好触及即触发）。
- **最短开关间隔**：开启后至少运行 `minOn`，关闭后至少停止 `minOff`。若阈值在
  禁止窗口内被触及，切换推迟到窗口结束时刻（前提是该时刻条件仍成立；若条件已
  消失则不切换）。初始状态的最短间隔自 `t0` 起算。
- **事件时间**：全部使用 `Rational`（BigInt 分数，自动约分、符号规范化），
  无浮点误差。

## 切换证据

每次切换输出一条 `SwitchEvent`：

| 字段 | 含义 |
| --- | --- |
| `time` / `temperature` | 切换时刻与当时室温（有理数） |
| `from` / `to` | 切换前后状态 |
| `threshold` | 触发阈值 |
| `crossingTime` | 触发条件首次成立并保持到切换的时刻 |
| `deferred` | 是否因最短开关间隔而推迟（`crossingTime < time`） |
| `minIntervalRequired` / `sincePreviousSwitch` | 要求的最短间隔 / 实际间隔 |
| `slopeBefore` / `slopeAfter` | 切换前后 `dT/dt` |
| `segmentIndex` | 切换点所在外部温度线段 |

## 独立核对（细分线段）

`verifySimulation(result, k)` 不依赖模拟器内部状态，独立重建轨迹并校验：

- 事件时间严格递增、状态交替、位于时域内；
- 最短开关间隔满足；切换时刻 `time == max(crossingTime, 最早允许时刻)`；
- 切换点温度与独立重建轨迹完全一致，触发条件按闭区间成立；
- 穿越点温度恰好等于阈值（区间内部穿越时）；
- 把相邻事件间每段**细分为 k 等份**，逐点检查：在允许切换的时刻绝不存在被
  遗漏的触发条件（防漏检）；
- 末状态、末温度与事件日志一致。

## 使用

```bash
npm test    # 编译（tsc -> dist/）并运行 node:test 测试
npm run demo  # 运行演示场景，打印切换证据表并自检
```

```ts
import { Rational } from "./src/rational.ts";
import { PiecewiseLinear } from "./src/piecewise.ts";
import { simulate } from "./src/thermostat.ts";
import { verifySimulation } from "./src/verify.ts";
```

说明：本机 Node v22.22.1 未内置类型剥离（type-stripping）支持，因此通过全局
`tsc` 编译到 `dist/` 后运行；`types/node-shim.d.ts` 提供所需的最小 Node 类型
声明，无需安装任何依赖。

## 实际测试结果

在 Node.js v22.22.1 上执行 `npm test` 的实际输出（2026-10-05）：

```
ok 1 - dist/test/piecewise.test.js
ok 2 - dist/test/rational.test.js
ok 3 - dist/test/thermostat.test.js
ok 4 - dist/test/verify.test.js
# tests 4
# pass 4
# fail 0
```

`npm run demo` 实际输出：

```
        idx     switch       time       temp  threshold   crossing   deferred     minReq  sincePrevslopeBefore slopeAfter
          0    off->on          3         11         18          0       true          3          3         -1          2
          1    on->off          7         22         22          7      false          2          4          5          2
          2    off->on       69/4         18         18       69/4      false          3       41/4       -8/3        1/3
          3    on->off       77/4       93/4         22     303/16       true          2          2          4          1
final: state=off temp=28 at t=30
verification: ok=true checks=111 subdivisions=16
```

测试覆盖：有理数运算与约分、分段线性插值/斜率/外延、闭区间阈值恰达触发、
滞回极限环（含恰好落在时域末端的切换）、`minOn`/`minOff` 推迟切换及其证据、
禁止窗口内触及阈值后恢复（不切换）、折点处恰好触及阈值、轨迹重建一致性、
非法配置拒绝，以及核对器对篡改事件时间/温度/穿越点、删除事件、追加事件、
错误末状态的检出。
