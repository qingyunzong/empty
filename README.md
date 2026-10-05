# weather-sessions

按事件时间对气象站观测进行会话（session）划分的库与 CLI。仅使用 Node.js 22 标准库与 `node:test`。

## 语义

- 输入记录按到达顺序处理：`UPSERT` / `RETRACT` / `WATERMARK`。
- 同一站点内，按事件时间排序后，相邻有效观测间隔 **≤ 10 分钟** 合并为一个会话，否则断开。
- 水位线 `W` 到达时，凡 **最大事件时间 + 10 分钟 < W** 的会话被最终化并输出：
  `station`、`start`、`end`、`count`、`avgTemp`、`ids`（成员观测 ID，按事件时间序）、`version`（成员观测版本号的最大值）。
- 会话最终化后，事件时间满足 `eventTime + 10min < 当前水位线` 的记录以 `LATE` 错误拒绝，不改变任何状态。
- `RETRACT` 在最终化前增量删除观测；删除中间点会使一个会话分裂为多个会话。
- 幂等与版本规则：
  - 同一 ID、相同版本的 `UPSERT` 为幂等空操作；
  - 版本回退（小于已见版本）报 `STALE_VERSION`；
  - 撤回未知 ID 报 `UNKNOWN_RETRACT`；
  - 重复撤回同一 ID（同版本）为幂等空操作。
- 水位线取历史最大值（单调递增，回退的水位线不生效）。

## 用法

```bash
node src/cli.js sessions --in data/sample.jsonl
```

- 最终化的会话以 JSONL 写入 **stdout**；
- 记录级错误（`LATE` / `STALE_VERSION` / `UNKNOWN_RETRACT`）以 JSON 写入 **stderr**，处理继续，退出码为 0；
- 致命错误（参数错误、文件不可读、非法 JSON、字段缺失等）写入 stderr 并以 **退出码 2** 终止。

## 输入格式

每行一个 JSON 对象：

```json
{"op":"UPSERT","id":"o1","station":"s1","eventTime":"2026-01-01T00:00:00Z","temp":10,"version":1}
{"op":"RETRACT","id":"o1","station":"s1","eventTime":"2026-01-01T00:00:00Z","version":1}
{"op":"WATERMARK","ts":"2026-01-01T01:00:00Z"}
```

`eventTime` / `ts` 接受 ISO 8601 字符串或 epoch 毫秒数。

## 库 API

```js
const { SessionStore } = require('./src/index');
const store = new SessionStore();
store.upsert({ id, station, eventTime, temp, version }); // -> {ok:true} | {ok:false, error}
store.retract({ id, version });                          // -> {ok:true} | {ok:false, error}
store.watermark(ts);                                     // -> [session, ...]
```

## 测试

```bash
node --test
```

测试包含一个独立的枚举参考实现（排序有效点后枚举所有间隔分组并求均值），与实现不共享任何代码。
