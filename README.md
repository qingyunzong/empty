# pressline-oee

冲压线离线 OEE 停机归因。输入可能乱序、重叠、带时钟回拨的 run/idle/fault/changeover/maintenance
事件流，输出规范化时间线、每段 label（含判定依据）、OEE 证书（JSON），以及对争议段的
最小误判反例。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 运行

```bash
node --test                                        # 全部测试
node bin/oee.js analyze examples/events.json       # 输出 OEE 证书 JSON
node bin/oee.js analyze examples/events.json --inject examples/inject.json --seed 42
node bin/oee.js counterexample examples/events.json --at 6300000
```

## 事件模型

```json
{ "id": "flt-1", "type": "fault", "start": 6000000, "end": 6600000 }
```

- `type ∈ {run, idle, fault, changeover, maintenance}`，`start/end` 为 epoch 毫秒安全整数，`end > start`。
- 相同 `id` 且内容完全一致 → 静默去重（应对重复上报）；相同 `id` 内容不同 → `ERR_CONFLICT`。
- 空流不是错误：返回空时间线，`availability/oee = null`。

## 机制

**区间代数**（`src/intervals.js`）：扫描线把乱序/重叠事件规范化为原子区间序列，每个区间记录
覆盖它的事件集合。相邻同刻事件（一个的 end 等于另一个的 start）天然拼成连续时间线，零宽区间
被丢弃。事件间隙标为 `uncovered`（默认不计入 OEE，可用 `uncovered: 'unplanned'` 改为计入）。

**优先级 × 阈值耦合分类器**（`src/classify.js`）：

- 优先级：`fault(40) > maintenance(30) > changeover(20) > idle(10) > run(0)`。重叠时高优先级
  获胜——例如 fault 覆盖 planned maintenance 时，该段判为 unplanned。若自定义优先级使两个
  不同类型并列最高 → `ERR_CONFLICT`。
- 阈值作用于**连通合并跨度**（同类型连续覆盖的总时长），而非单个原子区间：
  - `changeover` ≤ `changeoverPlannedThresholdMs`（默认 30min）→ planned，否则 unplanned；
  - `idle` ≤ `microStopThresholdMs`（默认 60s）→ planned（微停），否则 unplanned；
  - `fault` 恒 unplanned；`maintenance` 恒 planned；`run` 为生产时间。
- 每段 label 携带 `rule`、`winnerEventIds`、`spanDurationMs`、`thresholdMs`，可直接证明
  某段为何被判为计划外。

**OEE**：`availability = (plannedProductionTime − unplannedDowntime) / plannedProductionTime`，
其中 `plannedProductionTime = window − plannedDowntime(− uncovered)`；`oee = availability ×
performance × quality`。全天 planned maintenance 时分母为 0，`availability/oee = null`。

**时钟回拨**（`src/ingest.js`）：`Ingestor` 按序接收事件，容忍 `maxSkewMs`（默认 5min）内的
乱序；回拨超过阈值抛 `ERR_CLOCK` 且**状态不变**（事件未入列，可继续 ingest/analyze）。

**故障注入**（`src/inject.js`）：`skew`（平移时间戳）、`lost`（丢失）、`duplicate`（克隆，
新 id `xxx#dupN`），按 skew→lost→duplicate 固定顺序施加。随机选择由 `mulberry32(seed)`
驱动，同 seed+spec 完全可重放；操作日志写入证书 `injection.log`，并用
`replayInjections` 重放校验（证书内 `replayVerified: true`）。重复 fault 经区间合并不会
重复扣减 OEE。

**反例最小化**（`src/counterexample.js`）：给定争议时刻 `at`：
1. 贪心删除事件直至 1-minimal（再删任何一个都会使该点不再是 unplanned）；
2. 对存活事件的 start/end 二分收缩到最小（如 changeover 收缩到 `threshold+1`ms）；
3. 输出 `witnesses`：每个"删除该事件"或"再收缩 1ms"即可让该段从 unplanned 翻回 planned
   的具体操作，`verified1Minimal` 校验最小性。

## 错误码

| 代码 | 含义 |
|---|---|
| `ERR_SCHEMA` | 事件/参数不合法（缺 id、未知类型、`end <= start`、非整数时间戳等） |
| `ERR_CLOCK` | 时钟回拨超过 `maxSkewMs`，事件被拒绝且状态不变 |
| `ERR_CONFLICT` | 同 id 内容冲突，或自定义优先级下不同类型并列最高优先级重叠 |

CLI 出错时输出 `{"error": {code, message, details}}` 并以退出码 1 结束。

## 证书字段（节选）

```jsonc
{
  "kind": "oee-certificate",
  "params": { "maxSkewMs": 300000, "microStopThresholdMs": 60000, "...": "..." },
  "input": { "eventCount": 5, "sha256": "f6dd…" },
  "injection": { "seed": 42, "spec": {}, "log": [], "replayVerified": true },
  "timeline": [
    { "start": 3600000, "end": 5400000, "state": "changeover", "planned": true,
      "rule": "changeover-within-threshold", "winnerEventIds": ["co-1"],
      "spanDurationMs": 1800000, "thresholdMs": 1800000 }
  ],
  "oee": { "windowMs": 7230000, "unplannedDowntimeMs": 600000,
           "availability": 0.8888, "oee": 0.8888 }
}
```

## 验收对照

1. **≤14 事件与参考枚举一致**：`test/property.test.js` 用 400 个种子生成 ≤14 事件的随机流，
   扫描线实现与暴力枚举所有合法区间的参考实现（`src/reference.js`）逐段 deepEqual（时间线 + OEE）。
2. **回拨 > maxSkew 报 ERR_CLOCK 且状态不变**：`test/ingest.test.js` 断言失败后
   `ing.events` 不变、再次 `analyze()` 结果与之前 deepEqual。
3. **注入重复 fault 不重复扣 OEE**：`test/oee.test.js` + 性质测试（100 种子）断言注入
   `duplicate` 后 `unplannedDowntimeMs/availability/oee` 与注入前完全一致。
4. **争议段最小复现子集**：`test/counterexample.test.js` 验证 fault 场景最小子集只剩
   该 fault 事件（删除即翻回 planned），changeover 超阈值场景事件被收缩到 `threshold+1`ms
   且存在"再缩 1ms 即翻 planned"的 witness。

边界覆盖：空流（`normalize.test.js`）、全天 planned maintenance（OEE 为 null）、
相邻同刻事件（无缝拼接、无零宽区间）。

## 真实测试结果

`node --test`（Node.js v22.22.1，2026-10-03 于本仓库运行）：

```
ok 1 - test/classify.test.js
ok 2 - test/counterexample.test.js
ok 3 - test/helpers.js
ok 4 - test/ingest.test.js
ok 5 - test/inject.test.js
ok 6 - test/normalize.test.js
ok 7 - test/oee.test.js
ok 8 - test/property.test.js
ok 9 - test/schema.test.js
# tests 9
# pass 9
# fail 0
```

共 42 个子测试全部通过（classify 5 / counterexample 5 / ingest 5 / inject 6 /
normalize 5 / oee 4 / property 4 / schema 8）。

## 目录

```
src/errors.js          错误码与 OeeError
src/params.js          类型、默认参数与校验
src/schema.js          事件 schema 校验、去重/冲突
src/intervals.js       扫描线 + 参考枚举两种规范化
src/classify.js        优先级裁决与阈值分类
src/analyze.js         时间线构建、OEE、证书
src/ingest.js          有序接入与时钟回拨保护
src/inject.js          可重放故障注入（mulberry32）
src/counterexample.js  误判反例最小化（删除/收缩 + witnesses）
src/reference.js       参考实现（暴力枚举）
bin/oee.js             CLI（analyze / counterexample）
examples/              示例事件与注入 spec
test/                  node:test 测试
```
