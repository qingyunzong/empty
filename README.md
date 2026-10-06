# freeze-engine

银行卡额度冻结引擎。Node.js 22、仅标准库、`node:test`、单机离线、零依赖。

## 模型

- 时间为整数分钟，所有区间为**半开区间** `[start, end)`。
- 额度规则：
  - **总上限** `totalCap`：任意时刻所有活跃冻结金额之和不得超过。
  - **商户类日子上限** `categoryCaps`：每个类目在每个周期内，触及该周期的冻结金额之和不得超过（**跨周期结转**：跨重置点的冻结计入它触及的每一个周期）。
  - **周期重置点** `period: {origin, length, count}`：定义调度域 `[origin, origin + length*count)`。
- 一次冻结是一个 **group**（统一金额、类目）；部分解冻把它分裂为不相交的**片段**；用同一 `group` 重新冻结缺口会把相邻片段**合并**回去（输出合并证明 `merges`）。
- `advance(now)` 推进时钟：结束于 `now` 之前的片段**到期自动释放**，跨越 `now` 的片段截断已流逝前缀。`now` 是水位线，之后所有活跃片段都位于 `[now, domainEnd)` 内。
- `capture` 扣占：原子地从 group 金额中扣除，扣完即关闭；超过冻结金额拒绝（`E_LIMIT`），绝不部分扣占。

## 冲突裁决

`submit(batch)` 内按 **优先级降序、提交序（seq）升序** 确定性排序后逐条应用；每条请求原子生效或整体拒绝。请求可携带 `expectedVersion` 做乐观并发控制，版本不匹配拒绝 `E_RACE`。结果按应用顺序返回，拒绝携带确定原因（`code` + `reason` + `details`）。

## 错误码

| 代码 | 含义 |
|---|---|
| `E_LIMIT` | 总上限 / 类目子上限不足，或金额非法、扣占超额 |
| `E_INTERVAL` | 区间形状非法、与既有片段重叠、解冻不相交、未知 group |
| `E_PERIOD` | 区间超出调度域、起点在过去、时钟回拨或越过域终点 |
| `E_RACE` | `expectedVersion` 过期、冻结 id 重复 |

## 用法

库：

```js
import { LimitEngine } from './src/engine.js';
const engine = new LimitEngine({
  totalCap: 1000,
  categoryCaps: { DINE: 700 },
  period: { origin: 0, length: 1440, count: 3 },
});
engine.submitOne({ op: 'freeze', id: 'F1', category: 'DINE', amount: 400, start: 1000, end: 2000 });
engine.submit([reqA, reqB]);            // 批量：确定性仲裁
engine.submitOne({ op: 'unfreeze', group: 'F1', start: 1200, end: 1500 });
engine.submitOne({ op: 'capture', group: 'F1', amount: 100 });
engine.submitOne({ op: 'advance', now: 2001 });
engine.status();                        // now/version/normalized/periodUsage/groups
```

CLI：

```
node src/cli.js run examples/demo.json [--check]
```

`--check` 枚举调度域内每一分钟，校验任意点占用不超总上限、每周期类目用量不超子上限。

## 测试

```
node --test
```

真实输出（2026-10-06，Node v22.22.1）：

```
ok 1 - test/acceptance.test.js
ok 2 - test/fuzz.test.js
# tests 2
# suites 0
# pass 2
# fail 0
```

子测试（`node test/acceptance.test.js && node test/fuzz.test.js`）：

```
ok 1 - three overlapping freezes across a period reset
ok 2 - partial unfreeze splits, group re-freeze merges (with proof)
ok 3 - concurrent equal requests: one succeeds, others deterministically rejected
ok 4 - interval and period validation errors
ok 5 - capture deducts atomically and closes the group when fully captured
ok 1 - fuzz vs reference impl, seed 1: per-minute occupancy matches and never exceeds caps
ok 2 - fuzz vs reference impl, seed 7: per-minute occupancy matches and never exceeds caps
ok 3 - fuzz vs reference impl, seed 42: per-minute occupancy matches and never exceeds caps
ok 4 - fuzz vs reference impl, seed 1337: per-minute occupancy matches and never exceeds caps
ok 5 - fuzz vs reference impl, seed 20261006: per-minute occupancy matches and never exceeds caps
```

验收对照：

1. **三个重叠冻结跨越周期重置** — `acceptance.test.js` 用例 1：F1/F2/F3 跨过 t=1440 重置点，规范化区间集峰值占用 1000/1000；F1、F2 结转计入周期 0 与周期 1；第 4 笔 DINE 冻结在周期 1 子上限处被 `E_LIMIT` 拒绝；`advance(2001)` 自动释放 F1/F2 并截断 F3 的已流逝前缀。
2. **部分解冻分裂再合并** — 用例 2：`unfreeze [30,60)` 把 `[0,100)` 分裂为 `[0,30)`、`[60,100)`；同 group 再冻结 `[30,60)` 产生两条合并证明，复原为单片段 `[0,100)`。
3. **并发等值请求只成功其一** — 用例 3：三笔等值同优先级冻结，seq 最小者成功，其余 `E_LIMIT` 且原因确定；高优先级后提交者胜出；`expectedVersion` 过期者 `E_RACE`。
4. **小时间轴逐分钟对照** — `fuzz.test.js`：240 分钟时间轴、5 个种子、每种子 120 轮随机批次，与独立暴力参考实现（`src/refimpl.js`，逐分钟枚举）对照每分钟占用与每周期类目用量，且任意点占用不超上限。

## CLI 真实输出（`node src/cli.js run examples/demo.json --check`，节选）

```
step 04 | {...,"ok":false,"op":"freeze","id":"F4","code":"E_LIMIT","reason":"category 'DINE' cap exceeded in period 1: need 100, available 0",...}
step 06 | {...,"op":"freeze","group":"F3","merges":[{"group":"F3","merged":["F3#4","F3#6"],"into":"F3#4","interval":[1300,1800]},{"group":"F3","merged":["F3#4","F3#5"],"into":"F3#4","interval":[1300,2500]}],...}
step 08 | {...,"ok":true,"op":"freeze","group":"R1",...}
step 09 | {...,"ok":false,"op":"freeze","id":"R2","code":"E_LIMIT","reason":"total cap exceeded at [2000, 2100): need 400, available 300",...}
step 10 | {...,"ok":false,"op":"freeze","id":"R3","code":"E_LIMIT","reason":"total cap exceeded at [2000, 2100): need 400, available 300",...}
step 11 | {...,"op":"advance","now":2001,"expired":[{"group":"F1","fragment":"F1#1","end":2000},{"group":"F2","fragment":"F2#2","end":1600},{"group":"F3","fragment":"F3#4","end":2001,"truncated":[1300,2001]},{"group":"R1","fragment":"R1#7","end":2001,"truncated":[2000,2001]}],...}
CHECK OK: 4320 minutes enumerated, max occupancy 700/1000
rejected: 3
```

## 文件

- `src/engine.js` — 引擎（冻结/解冻/扣占/推进、仲裁、规范化输出、合并证明）
- `src/intervals.js` — 半开区间扫描线规范化
- `src/refimpl.js` — 独立暴力参考实现（仅测试对照用）
- `src/cli.js` — CLI
- `test/acceptance.test.js` / `test/fuzz.test.js` — 验收 1–3 / 验收 4
- `examples/demo.json` — CLI 演示脚本
