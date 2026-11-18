# Go 幂等存储库

供请求处理调用的并发安全幂等存储。相同键的首个请求执行处理函数，其余并发请求等待并复用同一结果；发布结果在 TTL 内复用；回收器只删除已过期且无在途请求的条目。

```go
import (
	"context"
	"time"

	idem "example.org/dlks/formal/q10055"
)

store := idem.New[string, []byte](30 * time.Second)

value, err := store.Do(ctx, requestKey, func(ctx context.Context) ([]byte, error) {
	return handleRequest(ctx)
})
```

## API

- `New[K, V](ttl)` / `NewStore[K, V](ttl)`：创建存储；`ttl <= 0` 表示结果不自动过期。
- `NewWithOptions[K, V](Options{TTL, Clock})` / `NewWithClock[K, V](ttl, clock)`：注入时钟，便于确定性测试。
- `Do(ctx, key, fn)`：执行或复用结果。成功值和错误都会缓存。
- `Get(key)`：读取已发布结果；在途条目不返回。
- `Delete(key)`：删除已完成结果；在途条目拒绝删除。
- `Reap()`：删除所有已过期且已完成的结果，返回删除数量。
- `Sweep(ctx, interval)`：按固定间隔调用 `Reap`，直到上下文取消。
- `Len()`、`InFlight()`、`Waiting(key)`：观测条目、在途执行和等待者数量。

## 语义

- 每个键同一时刻至多一个处理函数在执行，因此并发同键请求不会重复执行。
- 首个请求完成后，值或错误发布给全部等待者；之后在 TTL 内直接复用。
- TTL 从结果发布时开始计算，长耗时请求完成后仍获得完整有效期。
- `Reap` 和 `Delete` 都不会删除在途条目；发布与回收交错时不会产生第二个执行者。
- 等待者取消只影响自身，不取消首个请求，也不破坏已发布结果。
- 处理函数 panic 时，首个调用者继续 panic，等待者与后续调用收到包装了 `ErrPanic` 的错误。

## 验证

`idempotency_test.go` 包含并发同键、取消、panic、过期边界、回收与完成交错等测试。另有朴素请求表作为参考模型，穷举“开始、等待、推进时钟、回收、发布、删除”的全部 120 个有效顺序，并逐键核对执行次数与返回结果。

```sh
go test ./...
go test -race ./...
```
