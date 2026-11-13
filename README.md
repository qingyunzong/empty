# NetFlow/IPFIX template 世代解码

可导入的 Go 网络流模板状态库，支持 NetFlow v9 与 IPFIX：

- 按 exporter、observation domain、template ID 和接收世代管理模板。
- 解析包时先对模板做快照；同包内的模板刷新只从下一个包开始生效。
- 模板过期与缺失时都返回 `ErrNoTemplate` 或进入等待区，不会猜测字段。
- data template 与 option template 使用独立注册表、独立过期和独立解码。
- 无模板 data set 进入有界 FIFO；匹配后按原始接收顺序返回。
- 支持 IPFIX enterprise 字段、变长字段、模板撤销和 option scope 字段。

```go
store := dataeng.NewStore(dataeng.Config{
    MaxPending:     4096,
    MaxPendingBytes: 16 << 20,
    TemplateTTL:    30 * time.Minute,
})

sets, err := store.Receive("192.0.2.1", packet)
if err != nil {
    // Parse errors are reported; unknown templates queue instead of failing.
}
for _, set := range sets {
    for _, record := range set.Records {
        if value, ok := record.Get(8); ok { // sourceIPv4Address
            _ = value
        }
    }
}
```

`Receive` returns data sets that are newly deliverable. A template in the
current packet is installed after its data sets are handled, so data in the
same packet cannot use a newly refreshed layout. Queued data sets matched by
that template are returned first, preserving their receive order.
