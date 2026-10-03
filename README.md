# flight-track-matcher

Node.js 22（仅标准库 + `node:test`）实现的无人机地面观测匹配库与 CLI。

## 事件模型

输入为 JSONL，每行一个事件：

- `FLIGHT_PLAN`：`{type, flightId, start, end, polygon: [[x,y],...], version}`
- `GROUND_OBSERVATION`：`{type, obsId, ts, x, y}`
- `RETRACT`：`{type, flightId}` 撤回计划
- `WATERMARK`：`{type, ts}` 公共水位线

## 匹配语义

- 观测时间 `ts ∈ [start, end)` 且点在多边形内时匹配；点在多边形判定采用偶数规则，
  落在线上/顶点上的点算内部（`src/polygon.js`）。
- 同一 `flightId` 高版本覆盖低版本；低版本或同版本报 `STALE_VERSION`。
- 多个计划同时匹配时选择 `flightId` 字典序最小者；无匹配输出 `UNMATCHED`。
- 观测缓冲至水位线超过其时间 5 个时间单位后发布证书（`CERTIFICATE`）。
- 发布前：计划更正/新计划对所有缓冲观测重算；撤回计划级联 `WITHDRAW` 并重算。
- 发布后：任何时间窗覆盖已发布观测的计划修改/撤回报 `LATE` 并被拒绝。
- 校验错误：多边形少于 3 点报 `INVALID_POLYGON`；坐标非数字等报 `MALFORMED`；
  撤回未知 ID 报 `UNKNOWN_RETRACT`。

## CLI

```sh
node src/cli.js tracks --in events.jsonl [--out actions.jsonl]
```

输出 JSONL 动作流：`PLAN_ACCEPTED` / `MATCH` / `UNMATCHED` / `WITHDRAW` /
`PLAN_RETRACTED` / `CERTIFICATE` 及错误动作。示例见 `examples/events.jsonl`。

## 库

```js
const { TrackEngine } = require('./src/tracker');
const engine = new TrackEngine(); // { publishDelay } 可配，默认 5
const actions = engine.process(event); // 每个事件返回动作数组
const rest = engine.finish(); // 冲刷剩余缓冲观测
```

## 测试

```sh
node --test        # 或 npm test
```

最近一次真实运行结果见 `test-results.txt`。
