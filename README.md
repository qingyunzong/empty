# semaphore

动态容量加权信号量，仅依赖 Go 标准库。

## 语义

- **运行中缩容**：`Resize` 可缩小总容量；已授予令牌不撤销。超额期间
  （`InUse > Capacity`）停止一切新授予，直到释放腾出余量。
- **FIFO 等待**：`Acquire` 严格按入队顺序授予，队首不满足时后面不插队。
  取消的等待者被移出队列后立即重新评估队首，不留队首空洞。
- **守恒**：仅在 `inUse + n <= capacity` 时授予；`inUse` 允许因缩容暂时
  超过 `capacity`，但绝不会新增超额授予。`CheckConservation` 校验该不变量。
- 释放与扩缩容可任意交错（`Release`/`Resize` 均会触发队首授予评估）。

## API

- `New(capacity int64) *Semaphore`
- `Acquire(ctx, n) error` / `TryAcquire(n) bool` / `Release(n)`
- `Resize(newCapacity int64)`
- `Capacity()` / `InUse()` / `Waiters()` / `CheckConservation() error`

## 测试结果（实际记录）

环境：go1.27.1 linux/amd64。

```
$ go test -count=1 ./...
ok  	semaphore	0.744s
```

`go test -race -count=1 -v ./...`：15 个测试全部 PASS（1.859s），
无数据竞争。
