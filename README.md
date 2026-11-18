# 可嵌入 Go 延迟调度库

`formal` 提供一个无后台 goroutine、无外部依赖的延迟消息调度器。消息存放在稀疏多级时间轮中；每个槽位只负责索引，真实截止时间始终保留到纳秒。

## 保证

- 到期消息严格按绝对截止时间排序，同一时刻按提交顺序排序。
- 每条消息只触发一次；触发后 ID 可重新使用。
- `Cancel` 立即把消息从桶链表中摘除，空桶同时从轮位和非空通索引中删除，不占后续触发槽。
- 大延迟消息按层级放置；桶开始时间到达后，未到期消息会逐级提升到更低层。
- `Snapshot` 保存绝对 `Due`，`Restore` 在新时钟下重建时间轮，因此停机后剩余延迟仍然精确。
- 单实例通过互斥锁支持并发调用，可直接嵌入消息代理的现有事件循环。

## 使用

```go
clock := formal.NewManualClock(base)
s, err := formal.New(clock, formal.Config{
    Tick:      time.Millisecond,
    WheelSize: 64,
    MaxLevels: 8,
})
if err != nil {
    return err
}

_ = s.ScheduleAfter("order-42", 1500*time.Millisecond, order)

// 由宿主事件循环推进虚拟时钟并取走到期消息。
clock.Advance(1500 * time.Millisecond)
for _, event := range s.Poll() {
    deliver(event.ID, event.Payload)
}
```

生产环境可使用 `formal.SystemClock{}`。`Tick` 只影响轮位粒度；把 `Tick` 设为大于消息间隔不会造成提前或延迟触发。

## 重启重放

```go
snap := s.Snapshot()
blob, err := json.Marshal(snap)

// 新进程可以晚于快照时间启动。
var restoredSnap formal.Snapshot
err = json.Unmarshal(blob, &restoredSnap)

s2, err := formal.New(formal.SystemClock{}, formal.DefaultConfig())
err = s2.Restore(restoredSnap)
```

快照只包含尚未触发的消息。重启时已经过期的消息会在下一次 `Advance` 或 `Poll` 中按原截止时间顺序补发。

## 验证

`scheduler_test.go` 使用虚拟时钟与朴素最小堆逐步重算，并随机交错提交、取消、层级提升、时间跳进和快照重启，逐事件核对 ID 与绝对截止时间。

```sh
go test -race ./...
```
