# 日志多行事件边界

`dataeng` 是一个可直接嵌入 Go 日志采集器的多行聚合包。采集器按字节偏移读取文件，把完整物理行送入并发安全的聚合状态机；未完成行会留在缓冲区，不会因一次 `Poll` 结束而丢失。

## 规则

```go
rule := dataeng.Rule{
    Start:    dataeng.HasPrefix("2026-", "2027-"),
    Continue: dataeng.HasPrefix(" ", "\t"),
    Timeout:  dataeng.IdleTimeout(2 * time.Second),
}
agg := dataeng.NewAggregator(rule, dataeng.WithMaxEventBytes(1<<20))
```

- `Start` 优先匹配：命中后以 `ReasonNewStart` 结束旧事件，并开启新事件。
- 未命中 `Start` 时，若已有事件且 `Continue` 命中，则追加该行。
- 两个谓词都未命中时，同样结束旧事件并以该行开启新事件，避免静默丢行。
- `Timeout` 接收距上次追加的时长；`Push` 和定时 `FlushDue`/`Tick` 都会检查。

## 终止原因

| 原因 | 触发条件 |
| --- | --- |
| `ReasonNewStart` | 下一行开始新事件 |
| `ReasonTimeout` | 超时谓词命中 |
| `ReasonFlush` | 显式或定时 flush |
| `ReasonRotation` | 文件被重命名、替换或删除 |
| `ReasonTruncation` | 文件长度落后于已读偏移 |
| `ReasonEncoding` | 行不是合法 UTF-8 |
| `ReasonMaxBytes` | 事件达到最大字节预算 |

强制终止的事件在 `Event.Err` 中携带可用 `errors.Is` 判断的原因，例如 `ErrRotation`、`ErrTruncation`、`ErrEncoding`、`ErrMaxBytes`。事件同时保留 `StartOffset`/`EndOffset`。

## 恰好一次

`Aggregator` 用一个互斥锁串行化输入、超时和 flush。定时 flush 与新起始行竞争时，旧事件只会从其中一条路径提交一次；并发测试见 `TestFlushRaceWithNewStartEmitsOnce`。

```go
collector, err := dataeng.NewCollector("/var/log/app.log", agg)
events, err := collector.Poll()
if len(events) > 0 {
    // 发布 events
}
```

可单独运行定时器：

```go
ticker := time.NewTicker(500 * time.Millisecond)
defer ticker.Stop()
for range ticker.C {
    for _, event := range collector.Tick() {
        // 发布超时事件
    }
}
```

`Tick` 只使用规则中的超时谓词，不会无条件关闭事件。

## 恢复快照

`Collector.Snapshot` 返回可 JSON 序列化的 `CollectorState`：

- `Aggregator.Pending` 保存未完成事件的行、`StartOffset`、`EndOffset` 与序号。
- `ReadOffset` 是下一个待读字节，`Partial`/`PartialOffset` 保存已读取但尚未遇到换行的原始字节。
- `File` 保存 inode/mtime 信息；若恢复时路径已换成另一个文件，旧事件以 `ReasonRotation` 终止，并从新文件偏移 0 开始。

```go
state := collector.Snapshot()
payload, _ := json.Marshal(state)

// 进程重启后：
var restored dataeng.CollectorState
_ = json.Unmarshal(payload, &restored)

next, _ := dataeng.NewCollector("/var/log/app.log", dataeng.NewAggregator(rule))
_ = next.Restore(restored)
```

规则与选项（例如最大字节预算）不进入快照，恢复时必须配置成与产生快照时一致。
