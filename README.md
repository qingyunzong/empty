# silence-alarm

设备周期性静默（心跳缺失）报警检测库与 CLI。Node.js 22，仅使用标准库与 `node:test`，离线单机运行。

## 模型

- 时间均为整数毫秒时间戳。
- **班次偏移表**（已做时区转换）：`[{start, end, offsetMs}]`，按 `start` 排序、互不重叠。规则第 `k` 个周期的名义起点为 `epochStartMs + k * periodMs`，实际起点为名义起点加上该时刻在偏移表中查得的 `offsetMs`。周期边界落入偏移表缺口时报 `OFFSET_GAP` 错误。
- **规则**：`{id, epochStartMs, periodMs, expectedOffsetsMs[], graceMs}`。`periodMs <= 0` 报 `PERIOD_ZERO` 错误。每个周期内在 `periodStart + offset` 处应有心跳，宽限窗口为 `[e, e + graceMs]`。
- **周期判定**：
  - `ok`：所有已到期且未豁免的期望时刻均被心跳覆盖；
  - `silent`：存在未覆盖且宽限期已过的期望时刻；
  - `pending`：存在未覆盖但宽限期尚未截止的期望时刻（截止时刻后无法定论）；
  - `neutral`：无可判定期望（全部未到期或被停机豁免）。
- **报警区间**：连续 `silent`/`pending` 周期合并为一个报警区间；同一规则相邻报警区间间隙 `<= mergeGapMs`（可配置）时合并。未被后续正常周期结束的报警（延续到扫描前沿）标记为 `OPEN`，`end` 为 `null`——未收到结束信息不是错误。
- **计划停机**：`[{start, end}]`。期望时刻落在停机内则豁免；跨越停机边界的宽限窗口中，落在停机内的心跳不计入停机外的期望（边界前后分别判断）。
- **事件**：`append`（追加）、`retract`（撤回）、`override`（覆盖更正）。事件处理时间 `at`（缺省取 `time`）必须非递减，否则报 `TIME_INVERSION` 错误。每次事件输出受影响规则的 `correction`：规则版本号递增，并附证书——证书包含扫描过的周期边界 `boundaries`、截止时刻及 SHA-256 摘要，证明扫描范围。

## CLI

```
node bin/cli.js [input.ndjson] [output.ndjson]   # 缺省读 stdin、写 stdout
```

输入为 JSON 命令（每行一个），输出为 JSON 行：

- `{"cmd":"config","mergeGapMs":N}`
- `{"cmd":"shifts","table":[{start,end,offsetMs},...]}`
- `{"cmd":"downtime","intervals":[{start,end},...]}`
- `{"cmd":"rule","id":"r1","epochStartMs":0,"periodMs":1000,"expectedOffsetsMs":[100],"graceMs":50}`
- `{"cmd":"event","id":"h1","kind":"append|retract|override","time":100,"at":100}` → 输出 `correction` 行
- `{"cmd":"cutoff","time":5000}` → 设定截止时刻并输出 `alarms` 行
- `{"cmd":"alarms"}` → 输出当前 `alarms` 行

任何命令出错输出 `{"type":"error","code":...,"message":...}` 行，进程最终以退出码 1 结束。

## 库

```js
const { Engine } = require('./src/engine');
const engine = new Engine();
engine.setShiftTable(...); engine.setDowntime(...); engine.setMergeGap(...);
engine.addRule(...); engine.applyEvent(...); engine.setCutoff(...);
engine.alarms();            // [{ruleId, fromPeriod, toPeriod, start, end, status}]
engine.periodBoundaries(id) // 已扫描周期边界
```

`src/reference.js` 是独立的参考实现（逐周期枚举心跳集合），测试中用于与主引擎交叉对照。

## 测试

```
node --test
```

覆盖验收项：跨班次偏移切换的三个周期；撤回心跳生成报警并与后续报警按可配置间隙合并；停机边界与 OPEN 区间（与参考算法对照）；另含零周期、偏移表缺口、事件时间倒错三类错误及 CLI 集成测试。
