# incremental-spc

机加工质检站离线分析测量流：增量 SPC（Western Electric 子集规则）报警引擎，
支持历史更正、区间失效、故障注入重放，并为每个报警给出最小触发子集与
"是否由数据缺口 / 单位换算错误造成"的解释。纯 Node.js 22 标准库，无依赖。

## 运行

```bash
node --test          # 或 npm test
```

## 语义模型

- 流顺序 = 到达顺序（乱序由故障注入在到达前排列）。
- 每个有效点的控制限由**之前**最多 `windowSize` 个有效点的滑窗计算
  （总体标准差 σ，均值 mean）；有效样本 < `minSamples` 时该点状态为
  `UNKNOWN`（绝不误报"正常"），整体 `status()` 同样返回 `UNKNOWN`。
- 点状态：`UNKNOWN` / `IN_CONTROL` / `ALARM` / `EXCLUDED`（失效或 ERR_UNIT）。
- 规则（可配置子集，也可传自定义规则对象）：
  - `WE1` 1 点超出 3σ；`WE2` 近 3 点中 2 点同侧超 2σ；
    `WE3` 近 5 点中 4 点同侧超 1σ；`WE4` 连续 8 点同侧。
  - 自定义：`{ name, type: 'beyond', k, m, sigma }` 或 `{ name, type: 'run', run }`。
- 常数流 σ=0：等于均值的点不触发；任何偏离即超所有限时（严格不等）。
- 单位：配置 `unit` 后，单位不符的点若有 `conversions[unit]` 换算系数则换算并
  标记 `UNIT_CONVERTED`，否则标记 `ERR_UNIT` 并从统计中排除（可复现）。

## API

```js
const { SPC } = require('./src/spc');
const spc = new SPC({
  windowSize: 50, minSamples: 10,
  unit: 'mm', conversions: { in: 25.4 },
  rules: ['WE1', 'WE2', 'WE3', 'WE4'],   // 子集可配
});

spc.insert({ id: 'p0', value: 99.8 });        // -> { id, status, alarms }
spc.correct('p0', 100.2);                     // O(log n) 更新 + 全量重算报警
spc.invalidate('p10', 'p15');                 // 区间失效（含端点，按到达序）
spc.alarms();          // [{ rule, trigger, side, subset, limits, explanation }]
spc.controlLimits();   // { status, samples, limits: { mean, sigma, cl, ucl, lcl } }
spc.status();          // 'UNKNOWN' | 'IN_CONTROL' | 'ALARM'
spc.point('p0');       // { id, value, unit, valid, flags, status }
```

每个报警的 `subset` 是**最小触发子集**：子集中任一点从流中删除后，该报警
（同 rule + trigger + side）即消失；测试中用独立暴力重算 `src/reference.js`
逐点验证此性质。`explanation` 给出 `dataGap`（基线/模式跨度内存在失效点）与
`unitError`（跨度内存在 ERR_UNIT / UNIT_CONVERTED 点）及涉及点 id 列表。

## 复杂度

- `insert`：摊还 O(log n)（Fenwick 点更新 + 仅评估新点，报警只依赖过去）。
- `correct` / `invalidate`：Fenwick 点更新 O(log n)，随后 O(n log n) 重算报警；
  滑窗统计（count/sum/sumsq）每次查询 O(log n)，含 `select` 定位窗口起点。
- 最小子集：对每个候选点做一次删除-重算，O(候选数 · n log n)。

## 故障注入与重放

```js
const { FaultInjector } = require('./src/faults');
const injector = new FaultInjector({ seed: 99 });
injector.injectUnit('p100', 'in')   // 改单位 -> ERR_UNIT 标记点
        .drop('p120')               // 丢点
        .reorder(130, 140);         // 乱序（种子确定，可复现）
const log = injector.run(points, spc);        // JSON 可序列化注入记录
FaultInjector.replay(log, points, spc2);      // 重放 -> 完全相同的报警与标记
```

## 文件

- `src/spc.js` — 增量引擎（Fenwick 树、规则评估、最小子集、解释）
- `src/reference.js` — 独立朴素暴力参考实现（纯循环，无 Fenwick）
- `src/rules.js` — Western Electric 规则预设与自定义规则归一化
- `src/faults.js` — 故障注入器与确定性重放
- `test/spc.test.js` — node:test 验收测试

## 真实测试输出（node --test）

```
TAP version 13
# Subtest: test/spc.test.js
ok 1 - test/spc.test.js
  ---
  duration_ms: 913.056515
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
# duration_ms 928.259556
```

逐条子测试（`node test/spc.test.js`）真实输出摘要：

```
ok 1 - acceptance 1: 200-point random stream matches naive reference
ok 2 - acceptance 2: correcting a historical point matches full recompute
ok 3 - acceptance 3: unit injection yields reproducible ERR_UNIT flags
ok 4 - acceptance 4: insufficient samples report UNKNOWN, never a false OK
ok 5 - edge: all points invalidated -> UNKNOWN, no alarms
ok 6 - edge: constant stream has sigma 0; a single deviation trips WE1
ok 7 - invalidate(range) matches brute-force reference and explains data gaps
ok 8 - minimal triggering subset: deleting any subset point kills the alarm
ok 9 - out-of-order (reorder) injection still matches reference
ok 10 - configurable rule subsets and custom rules match reference
ok 11 - known unit conversions convert and flag instead of ERR_UNIT
1..11
# tests 11
# pass 11
# fail 0
# duration_ms 1123.484922
```
