# Webhook 乱序补偿水位

SaaS 同步入口需要可直接接入的 Go webhook 归并组件，按资源版本、事件 id 和签发时间处理重复、乱序及缺口。删除墓碑不能被迟到更新复活；发现版本跳跃时生成一次补拉请求，并把补拉快照与期间事件按版本合并。崩溃恢复后保持相同最终状态和外发序列。

## 用法

```go
store, _ := dataeng.NewFileStore("wal.log") // 崩溃恢复用 WAL；测试可用 NewMemStore()
rec, _ := dataeng.NewReconciler(store, dataeng.WithSink(func(rec dataeng.OutboundRecord) {
    // 归并后的外发序列，Seq 单调递增且恢复后不重用
}))

// webhook 入口
_ = rec.HandleEvent(dataeng.Event{ID: "evt-1", ResourceID: "user-1", Version: 7, IssuedAt: ts, Type: dataeng.EventUpsert, Payload: body})

// 版本跳跃时，每个缺口 episode 只发出一次补拉请求
go func() {
    for req := range rec.Backfills() {
        snap := fetchSnapshot(req.ResourceID, req.FromVersion, req.ToVersion) // 调用 SaaS API
        _ = rec.HandleSnapshot(snap) // 快照与期间缓存事件按版本合并
    }
}()
```

## 语义

- 去重：事件 id 全局去重，重复投递直接丢弃。
- 乱序：版本等于水位 +1 才应用，超前版本缓存等待；同版本冲突保留签发时间更晚的副本。
- 墓碑：删除推进版本水位，迟到 upsert（版本 ≤ 墓碑版本）被丢弃，不会复活；更高版本的 upsert 视为合法重建。
- 缺口：发现版本跳跃时缓存事件并发出一次 `BackfillRequest`；补拉快照到达后按版本合并——低于快照版本的缓存事件被取代，高于的按序应用；快照仍未覆盖的缺口会开启新一轮补拉。
- 恢复：所有接受的输入先写 WAL（fsync）再生效，重放确定性重建相同最终状态与外发序列；崩溃时写了一半的尾部记录会在重放时截断；恢复后仍未闭合的缺口会重新发出补拉请求。
