# OpenTelemetry trace 补链

链路数据管线需要可导入的 Go trace 补链库，把乱序 span、link、resource 和 scope 归并为版本化 trace。相同 span id 内容冲突隔离，缺父 span 不阻塞超时发布但标记根因；迟到父节点到达后生成修订事件而非重发整条 trace。

## 用法

```go
asm := dataeng.New(dataeng.Options{
    PublishTimeout: 30 * time.Second, // 首条 span 到达后的快照发布期限
})

// 摄入乱序 span（resource/scope/link 随 span 携带，一并归并）。
// 已发布 trace 的迟到数据会同步返回增量修订事件。
for _, ev := range asm.Add(span) {
    publish(ev) // EventRevision：只含变化的 span
}

// 周期性调用（如 ticker），超时 trace 发布全量快照；
// 缺父 span 不阻塞，根因写入 Event.Orphans。
for _, ev := range asm.FlushExpired(time.Now()) {
    publish(ev) // EventSnapshot：Version 从 1 开始
}
```

## 语义

- **版本化**：每条 trace 的 `Event.Version` 单调递增，快照为 1，之后每次修订 +1；下游按 `(TraceID, Version)` 顺序应用。
- **冲突隔离**：同一 span id 内容不一致时保留先到版本，冲突副本记入 `Event.Conflicts`，绝不并入 trace 主体；完全相同的重复投递直接丢弃。
- **缺父不阻塞**：`PublishTimeout` 到期即发布快照，未归队的父节点以 `OrphanCause`（缺失父 id、受影响 span、已等待时长）标记根因。
- **迟到父节点**：发布后到达的父 span 生成 `EventRevision`，仅携带新 span 与 `ResolvedOrphans`，不重发整条 trace。
- **内存回收**：trace 消费完毕后调用 `Forget(traceID)` 释放状态。

## 测试

```sh
go test ./... -race
```
