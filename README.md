# device-uptime-causal

单机离线判定多设备启停历史。仅依赖 Node.js 22 标准库，测试使用 `node:test`。

## 数据模型

事件（JSON）：

```json
{ "id": "e1", "device": "A", "ts": 10, "state": "down", "node": "n1", "clock": { "n1": 1 } }
```

- `state` 为 `up` / `down`；`clock` 为向量时钟（节点名 -> 非负整数计数器）。
- `down` 开启停机区间，下一个 `up` 关闭它；缺失 end 为开放区间，水位线（watermark）
  未到达时 end 为 `null`，相关停机时长与可用率为 `null`。
- 事件按向量时钟构成因果偏序；分析时枚举该偏序的全部拓扑序（线性化）。

## 语义

- 所有线性化得到相同停机时长 -> `status: "ok"`，输出停机区间并集、停机时长、可用率。
- 并发启停在不同线性化下结果不同 -> `status: "ambiguous"`，输出全部拓扑序中的
  `minDowntime` / `maxDowntime`（以及 `minAvailability` / `maxAvailability`），
  未决情况不是错误。
- 重复事件按 `id` 幂等丢弃，不推进版本。
- 迟到事件（ts 早于同设备已存最新 ts）被接受，但以带版本的增量更正
  （`corrections`，含 `version` / `eventId` / `reason: "late-event"`）记录。

## CLI

```sh
node src/cli.js ingest --db state.json [--file events.json]   # 无 --file 时读 stdin，支持 JSON 数组/NDJSON
node src/cli.js query  --db state.json [--watermark N] [--device NAME]
node src/cli.js diff   old-state.json new-state.json
```

退出码：`0` 成功；`1` schema 错误；`2` 用法/IO 错误。

## 测试

```sh
node --test
```

其中 `test/analyze.test.js` 对 ≤8 个事件的设备用独立的全排列暴力枚举全部合法
线性化，与库内拓扑排序枚举的停机时长多重集逐一核对。

`result.txt` 记录了三个验收场景（因果乱序确定结果、并发 toggle ambiguous、
缺失 end 未到水位线为 null）的真实 CLI 输出与退出码。
