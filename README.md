# 浏览器 HAR 分片实时归档

可导入的 Go 包 `dataeng`（module `example.org/dataeng/q0201`），把并发页面
采集到的请求、响应、重定向与正文 blob，按 **run / target / request id** 归并
成 HAR 记录，并支持乱序事件、晚到正文、封闭后修订世代与崩溃恢复。

## 核心能力

- **乱序归并**：同一 `(run, target, request_id)` 的事件合并为一条 `Record`；
  响应先到也能闭合，请求头后补。未闭合记录实时快照到 `open/`。
- **封闭与修订世代**：`CloseRun` 把记录固化为不可变基础世代 `rev=0`；
  封闭后迟到的每个事件生成一个修订世代 `gen-000001...`，基础世代不变。
- **blob 去重、来源独立**：正文按摘要内容寻址，相同字节只存一份数据；
  每个来源关系（role/run/target/request/event）独立登记、幂等去重。
- **WAL 崩溃恢复**：事件先落分段 WAL（魔数 + 长度 + CRC32），半帧/坏 CRC
  显式报错。重放重建 open 快照、base 与修订世代，事件 ID 幂等。
- **发布账本**：已发布的世代单元记入 `publish/ledger.json`，进程重启后
  `PendingPublish`/`PublishStream` 不会重复发布，只输出增量修订。
- **HAR 1.2 导出**：`ExportHAR` 输出标准 HAR，正文默认按 blob 引用输出，
  可用 `InlineBodies` 内联字节。

## 磁盘布局

```
root/
  runs/<run>/meta.json                  run 元数据（sealed、revision_seq）
  runs/<run>/wal/00000001.wal           分段事件 WAL（CRC32 帧）
  runs/<run>/open/<target>/<req>.json   未闭合记录快照（每次归并原子重写）
  runs/<run>/base/<target>/<req>.json   封闭时固化的基础世代（rev=0）
  runs/<run>/revs/index.json            修订世代索引
  runs/<run>/revs/gen-000001/<target>/<req>.json
  blobs/data/<algo>/<digest[:2]>/<digest>   内容寻址正文（全局去重）
  blobs/refs/<algo>/<digest>.json           blob 的独立来源关系清单
  publish/ledger.json                   发布幂等账本
```

所有外部标识（run/target/request id）落盘前经 `safeSegment` 清洗，杜绝路径穿越。

## 快速上手

```go
a, err := dataeng.Open("/var/lib/har-archive")           // 不存在则初始化
defer a.Close()

a.Ingest(dataeng.Event{
    Type: dataeng.EvRequest, Run: "run-1", Target: "page-A", RequestID: "req-1",
    Fields: map[string]any{"method": "GET", "url": "https://example.test/"},
})
a.Ingest(dataeng.Event{
    Type: dataeng.EvResponseBody, Run: "run-1", Target: "page-A", RequestID: "req-1",
    Body: []byte("<html>...</html>"),
})

summary, _ := a.CloseRun("run-1")                        // 封闭基础世代

// 封闭后迟到事件自动进入修订世代
a.Ingest(dataeng.Event{Type: dataeng.EvResponse, Run: "run-1", /* ... */})

items, _ := a.PendingPublish("run-1")                    // 未发布的世代单元
keys := make([]string, len(items))
for i, it := range items { keys[i] = it.Key }
a.MarkPublished(keys)                                    // 下游确认后记账

har, _ := a.ExportHAR("run-1", dataeng.ExportOptions{InlineBodies: false})
```

## 事件与幂等

- `Event.ID` 为空时按事件全部内容（含正文 SHA256）确定性派生，重放得到相同 ID。
- 已应用的事件 ID 在 run 内去重；重复投递不会二次归并、不产生新修订世代。
- 正文事件可直接给 `Body`（组件算摘要落盘），也可只给 `BlobAlgo/BlobDigest`
  引用外部已存 blob。

## 配置项

- `WithNoSync()`：关闭逐次 fsync，提升吞吐，代价是崩溃可能丢失最后若干帧。
- `WithWALMaxBytes(n)`：单个 WAL 分段滚动阈值（默认 32MiB）。

## 测试

```
go test ./...          # 含乱序归并、修订世代、恢复重放、发布幂等等用例
go test -race ./...
```
