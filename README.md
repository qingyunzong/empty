# meteo-corrections

气象观测时间序列更正库与 CLI。Node.js 22，仅标准库与 `node:test`，全程离线。

## 功能

- 按时间排序的观测点序列（重复时间戳拒绝，`E_TS`）。
- 派生节点：滑动均值 / 方差窗口；窗口长度可修改，修改后依赖关系动态重建并全量重算该节点。
- 更正事务：`set`（置值）、`offset`（偏移）、`scale`（比例缩放），必须携带 `reason` 与 `cts`（更正时间戳），否则 `E_INVALID`。
- 增量维护：仅重算受影响窗口，输出新旧值差分（`diffs`）、受影响区间（`affected`）与确定性哈希证书（`certificate`，对规范化 JSON 的 SHA-256）。
- 早于 `finalizeHorizon` 的观测拒绝更正（`E_FINALIZED`）；目标不存在返回 `E_RANGE`。
- 撤销 / 重做：更正事务按批入栈，新更正写入时清空重做栈。
- 乱序送达的更正先按 `cts` 归位（稳定排序，同刻按到达序），再触发最小失效集合（`recomputed` 计数可验证）。

## 库用法

```js
const { Series } = require('./src/series');
const s = new Series({ finalizeHorizon: 100 });
s.addObservation(1, 10);
s.addNode({ id: 'm3', type: 'mean', window: 3 });
s.applyCorrections([{ op: 'offset', ts: 1, value: 2, reason: 'calibration', cts: 1 }]);
s.undo(); s.redo();
s.snapshot(); // { observations, nodes, log, certificate }
```

## CLI

从 stdin 读取 JSON，向 stdout 输出结果：

```sh
echo '{"observations":[{"ts":1,"value":10}],"nodes":[{"id":"m2","type":"mean","window":2}],
"ops":[{"cmd":"correct","op":"offset","ts":1,"value":2,"reason":"r","cts":1}]}' | node cli.js
```

字段：`finalizeHorizon`、`observations`、`nodes`、`corrections`（单条更正列表）、`ops`
（`addObservation` / `addNode` / `setWindow` / `correct`（支持 `corrections` 批量）/
`undo` / `redo` / `finalize`）。输出：`{ ok, events, state }`，每个事件含
`diffs`、`affected`、`recomputed`、`certificate`。非法 JSON 返回 `E_PARSE`（退出码 1）。

## 测试

```sh
node --test
```

测试覆盖：≤12 点、3 窗口下与全序列枚举参考的增量结果 / 差分对比；乱序更正归位与最小失效集合；
越界更正、零窗口、撤销后重做、空序列等边界；CLI 端到端与确定性。
