# 隧道分片重组库

供隧道收包路径同步调用的 Go 分片重组实现，不启动后台 goroutine，超时与容量回收由调用方驱动。

## 用法

```go
r, err := formal.New(formal.Config{
    MaxMemory:     8 << 20,   // 所有未完成报文的数据总预算
    MaxPacketSize: 64 << 10,  // 单个报文最大长度
    Timeout:       30 * time.Second,
})

res, err := r.Add(formal.Fragment{
    Key:    formal.Key{TunnelID: vni, PacketID: id},
    Offset: off,
    Data:   payload,
    Last:   !more,
})
if res.Complete {
    deliver(res.Data)
}
```

`Add` 会复制分片数据，返回后调用方可立即复用收包缓冲区。`AddAt`/`ExpireAt` 接受显式时间，便于确定性地驱动超时测试；`Add`/`Expire` 使用配置的 `Clock`（默认 `time.Now`）。

## 语义

- 分片严格按 `(TunnelID, PacketID)` 隔离，不同隧道或报文标识的同偏移数据互不影响。
- 支持任意到达顺序。由 `Last` 或 `Total` 确定报文总长，只有 `[0,total)` 无空洞时才返回 `Complete`。
- 完全重复或字节一致的重叠不重复计费，`Result.Duplicate` 标记未引入新字节。
- 字节不一致的重叠返回 `ErrOverlapConflict`，并丢弃整个未完成报文，避免歧义数据被交付。
- 总长不一致、越过已知总长、非法偏移/长度分别返回 `ErrTotalMismatch`、`ErrFragmentOutOfBounds`、`ErrInvalidFragment`；超过单包上限返回 `ErrPacketTooLarge`。
- 超时从首片到达时开始计算，重复分片不会续期。到达截止时刻即过期。
- 数据总量超过 `MaxMemory` 时，按 `(deadline, 首次到达序号)` 依次驱逐，先到期的先淘汰，同到期时间按到达顺序稳定选择。正在更新的报文不会被自身驱逐；若保留其已有片段仍无法容纳，则返回 `ErrMemoryLimit` 且不改变状态。
- 完成、超时、显式 `Remove`、冲突丢弃和容量驱逐都会一次性释放该报文全部计费。`MemoryUsed()` 应始终等于各未完成报文数据之和。
- 所有方法并发安全。库内不计元数据开销，`MaxMemory` 统计的是保留的分片载荷字节。

报文完成后再到达的迟到副本会被视为新报文并最终超时；若上游报文标识可能快速复用，应在隧道层按标识去重或保证超时窗口内不重用标识。

## 验证

`reassembly_test.go` 覆盖乱序、重复、一致重叠、冲突分类、超时、稳定驱逐、显式删除及随机分片序列，并在每次操作后重算计费与堆索引不变量。

```sh
go test -race ./...
```
