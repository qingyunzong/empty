# incremental-spc

机加工质检站离线分析测量流：增量 SPC（Western Electric 子集规则）报警引擎。
Node.js 22，仅标准库，测试用 `node:test`。

## 功能

- `insert(point)` / `correct(id, value)` / `invalidate(fromSeq, toSeq)` / `rules` 配置
- 输出 `status`（`OK` / `ALARM` / `UNKNOWN`）、`alarms`、`controlLimits`，
  每个报警带**最小触发子集** `minimalSubset`
- 滑窗统计用三棵 Fenwick 树（有效点数 / 和 / 平方和）维护：
  `correct` 单点更新 O(log n)，窗口均值/方差 O(log n) 重算；
  `invalidate(range)` 为 O(k log n)（k 为失效点数）。
  报警扫描本身是对窗口的 O(W) 遍历；结构性插入（含乱序）重建树 O(n)
- 故障注入：改单位（`ERR_UNIT` 标记并剔除出统计）、丢点、乱序；
  全部操作写入 `engine.log`，`replayLog(log, options)` 可逐位复现状态
- 误报反例最小化：贪心删除至 1-最小——删去子集中任一点，报警即消失；
  语义为"在报警所在窗口的固定 (μ, σ) 下，子集仍触发同一规则"，
  测试中用独立编写的暴力检查器逐点验证
- 边界：常数流（σ=0，控制限坍缩到中心线，无报警）、单点、全部失效
- 样本不足（`validCount < minSamples`）一律返回 `UNKNOWN`，绝不报"正常"

## 结构

- `src/spc.js` — 增量引擎（Fenwick 树 + 规则检测 + 子集最小化）
- `src/naive.js` — 独立朴素参考实现（纯数组 O(n) 循环，与引擎零共享代码）
- `src/faults.js` — `FaultInjector`（改单位/丢点/乱序，种子化确定性）与 `replayLog`
- `test/spc.test.js` — 验收测试

## 用法

```js
import { SPCEngine } from './src/spc.js';
import { FaultInjector, replayLog } from './src/faults.js';

const engine = new SPCEngine({
  windowSize: 80,
  minSamples: 5,
  rules: { runSide: { run: 8 } },          // 可裁剪/调阈值，默认 WE 四条子集规则
  unit: { expected: 'mm', autoDetect: true, factor: 5 },
});

engine.insert({ id: 'p1', value: 100.2, unit: 'mm' });
engine.correct('p1', 100.4);               // 更正历史点，O(log n) 统计更新
engine.invalidate(10, 20);                 // 按 seq 区间失效

const injector = new FaultInjector(engine, { seed: 3 });
injector.changeUnit({ id: 'u1', value: 100 }, 'in'); // -> ERR_UNIT 标记点
injector.drop({ id: 'lost', value: 99.8 });
injector.reorder(batch);                   // 乱序到达

const state = engine.getState();
// state.status / state.alarms[i].minimalSubset / state.controlLimits / state.flaggedPoints

const replica = replayLog(engine.log, options); // 重放，状态完全一致
```

## 报警规则（默认配置，均可裁剪）

| 规则 | 键名 | 默认 |
|---|---|---|
| 单点超 kσ | `beyondSigma` | k=3 |
| n/m 点同侧超 kσ | `twoOfThree` | k=2, 2/3 |
| n/m 点同侧超 kσ | `fourOfFive` | k=1, 4/5 |
| 连续同侧中心线 | `runSide` | 8 点 |

## 测试

`node --test` 真实输出：

```
TAP version 13
# Subtest: test/spc.test.js
ok 1 - test/spc.test.js
  ---
  duration_ms: 1394.907039
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1476.240035
```

覆盖验收项：

1. 200 点随机流（种子化）与朴素参考的报警集合、控制限一致（`200-point random stream matches naive reference`，另有逐步增量对照）
2. 更正历史点 / 失效区间后，alarms 与全量朴素重算一致（`correcting historical points keeps alarms equal to full recompute`）
3. 单位注入产生可复现的 `ERR_UNIT` 标记点，重放日志逐位一致（`unit injection produces reproducible ERR_UNIT flags`）
4. 样本不足返回 `UNKNOWN` 而非正常（`insufficient samples yield UNKNOWN`）

另有：常数流/单点/全部失效边界、四条规则各自的最小触发子集、
丢点与乱序注入重放、规则可配置性。
