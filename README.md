# journald cursor 世代恢复

主机日志连接器需要可直接接入 Go journal cursor 状态组件，处理 seek cursor、boot id、realtime/monotonic timestamp 与 vacuum 导致的游标失效。恢复时先验证 cursor 对应条目，再决定继续或按时间补扫；补扫结果按唯一字段集去重，跨 boot 不比较单调时间。

## 组件

- `State`（cursor.go）：可 JSON 持久化的消费位置，含 cursor、boot id、realtime/monotonic 时间戳。
- `Reader`（journal.go）：对齐 sd_journal 语义的读取抽象，可直接适配 go-systemd sdjournal；`ValidateCursor` 通过 seek 后比对实际游标来识别 vacuum 造成的游标失效。
- `Deduper`（dedup.go）：按唯一字段集（默认 `_BOOT_ID` + `__REALTIME_TIMESTAMP` + `__MONOTONIC_TIMESTAMP`）去重的有界 FIFO 窗口。
- `Connector`（recover.go）：`Open` 时做恢复决策——状态为空则从头/尾开始；游标验证通过则从游标继续；否则回退到按 realtime 补扫，补扫期间按保存状态过滤已覆盖条目（跨 boot 不比较 monotonic），重叠部分由去重窗口吸收。

## 用法

```go
saved, _ := dataeng.ParseState(snapshot) // 上次持久化的状态，可为空
c, err := dataeng.Open(reader, saved, &dataeng.Options{
    StartAtHead:   false,
    DedupCapacity: 8192,
})
if err != nil { /* ... */ }
switch c.Mode() {
case dataeng.ResumeCursor:   // 游标有效，继续
case dataeng.ResumeBackfill: // 游标失效，按时间补扫
}
for {
    e, err := c.Next()
    if errors.Is(err, io.EOF) { break }
    ship(e)
    snapshot, _ = c.State().Marshal() // 逐条或批量持久化
}
```

运行测试：`go test ./...`
