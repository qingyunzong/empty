# 断点片段的重叠与空洞

`dataeng` 是一个可导入的 Go 包，只拼接下载采集到的内容范围，不发起任何传输。所有区间都是半开区间 `[start, end)`，每段的 `Data` 长度必须等于 `end-start`。

主要 API：

```go
l := dataeng.NewLedger()
l.AddSegment(dataeng.Segment{Start: 0, End: 4, Data: []byte("abcd"), Source: "head"})
l.AddSuffix(dataeng.Suffix{Length: 2, Data: []byte("yz"), Source: "tail"})
l.SetTotalSize(6)
snap := l.Snapshot()
```

语义：

- 相同字节的重叠（以及相邻区间）会合并，来源集合取并集。
- 重叠处只要有一个字节不同，整个传入段就被拒绝，既有内容保持不变；冲突按连续的不一致字节段记录，并保留实际覆盖这些字节的既有来源与传入来源。
- 后缀在总长度未知时只进入 `PendingSuffixes`，不占用任何区间，也不影响空洞计算；总长度确定后才落到 `[Total-Length, Total)`。
- `SetTotalSize` 是原子的。总长度小于已覆盖末尾时返回 `ErrTotalConflict`；总长度小于待处理后缀时返回 `ErrSuffixExceedsTotal`，账本保持原状。
- 中间未覆盖区间作为 `Holes` 显式返回，不填充零字节。总长度未知时只报告到最后一个已覆盖字节为止的空洞，未知的尾部不当作空洞。
- `Complete` 仅在总长度已知、`[0, TotalSize)` 全部覆盖且从未记录过冲突时为真。

验证使用 `go test ./...`。测试同时包含硬编码期望和独立的逐字节区间账本；测试期望由独立模型或字面量给出，不调用被测包生成期望值。
