# 带租约与 fencing token 的公平锁

面向协调服务客户端的 Go 锁库。业务组件只依赖 `Client`；协调服务通过
`Backend` 接口抽象。仓库内提供内存实现 `Coordinator`，用于测试和单进程集成。

## 语义

- **会话租约**：`Client` 持有一个带 TTL 的会话。`KeepAlive` 续租；租约过期或连接
  丢失时，服务端立即撤销该会话持有的全部锁，并移除其排队请求。
- **公平排队**：服务端为每个 `Acquire` 分配单调递增序号，队列严格 FIFO。只有队首
  存活请求能得到锁。
- **同会话重入**：同一 `Client` 再次获取已持有的锁时立即返回，复用原 token，仅增加
  递归深度。最后一个嵌套句柄 `Unlock` 时才真正释放。
- **fencing token**：每次所有权转移分配全局严格递增的新 token，重入不换 token。
  受保护资源用 `Fencer.Allow` 拒绝非递增 token；旧 token 不会被重新签发。
- **断连阻断**：会话断开后 `Acquire` 返回 `ErrDisconnected`，不会进入新队列。恢复时
  `Reconnect` 创建全新会话。旧会话的迟到/重复回调按 session 丢弃。
- **至少一次回调**：`Client.Deliver` 幂等，重复的 grant、revoke、session-lost 通知
  不会重复增加深度或释放新持有者。

生产环境的 `Backend` 必须持久化序号与 token 计数器；服务重启后若重置计数器，旧
token 可能重新变得有效。`Fencer` 也应在资源侧重启后保留已接受的最大 token。

## 使用

```go
coordinator := formal.NewCoordinator(formal.SystemClock{})
client, err := formal.NewClient(coordinator, 30*time.Second)
if err != nil {
    return err
}
defer client.Close()

// 生产环境应在 TTL 内周期续租。
go client.KeepAliveLoop(ctx, 10*time.Second)

handle, err := client.Acquire(ctx, "orders/42")
if err != nil {
    return err
}
defer handle.Unlock()

var fencer formal.Fencer
if !fencer.Allow(handle.Token()) {
    return formal.ErrStaleToken
}
// 在 token 保护下修改资源。
```

`Fencer` 应按受保护资源分别持有；每次写操作前都应调用 `Allow`。

## 失败与恢复

```go
if !client.Connected() {
    if err := client.Reconnect(); err != nil {
        return err
    }
}
```

重新连接会得到新的 session id。旧句柄立即失效，`Unlock` 返回
`ErrLockLost`，且不会影响新持有者。新持有者取得更大的 token，资源端的
`Fencer` 会永久拒绝旧 token。

## 测试

```sh
go test ./...
go test -race ./...
```

`FakeClock.Advance` 控制租约过期，`Coordinator.Disconnect` 模拟链路中断，
`recordingBackend` 在测试中重复投递每个回调。覆盖互斥、队首 FIFO、取消队首、
过期队首跳过、重入深度、token 严格递增、断连恢复和重复回调幂等。
