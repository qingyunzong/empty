# tokenbucket

持久化令牌桶限流库，仅依赖 Go 标准库。

## 设计

- **显式单调逻辑时间**：调用方以 `int64` tick 提供时间（`Allow(now, ...)`）。
  时钟倒退时被钳制：不补令牌，`lastTime` 永不回退。
- **整数速率 + 余数累计**：速率配置为 `RateNum/RateDen`（令牌/tick）。
  每次补充以 `rem + elapsed*RateNum` 整除累计，余数保留在
  `[0, RateDen)` 内，不丢也不多产令牌。数学上等价于有理数模型
  向下取整（`reference_test.go` 中的 `ratModel` 用 `math/big.Rat` 核对）。
- **幂等决议**：每个请求 ID 的首次决议（含扣费后的完整桶状态）追加到
  JSON Lines 日志并 fsync。重复 ID 直接返回原决议，不再扣费；
  重启后重放日志，同样不会重复扣费。
- **日志截断保留幂等窗口**：`Truncate(keep)` 原子重写日志（tmp + rename +
  dirsync），头部写入状态快照，其后保留最近 `keep` 条决议记录。
  窗口内的 ID 重启后仍幂等；窗口外的旧 ID 被视为新请求。
  快照保证即使 `keep=0`，重启也不会回拨时钟或白补令牌。
  `WithAutoTruncate(maxRecords, window)` 可自动截断。

## 用法

```go
s, err := tokenbucket.Open("log.jsonl", tokenbucket.Config{
    Capacity: 100, RateNum: 1, RateDen: 2, // 每 2 tick 补 1 令牌
})
if err != nil { ... }
defer s.Close()

allowed, err := s.Allow(now, "request-123", 1) // now 为逻辑时钟
```

## 测试

`go test ./...`（Go 1.27.1，linux/amd64）实际结果：

```
ok  	tokenbucket	0.179s
```

12 个测试全部通过，包括：

- `TestBucketMatchesRationalModel`：40 组随机配置 × 500 步随机操作
  （含时钟倒退），逐步与 `big.Rat` 有理数参考模型核对决议与精确状态。
- `TestStoreEndToEndModel`：25 个种子 × 300 步随机操作（请求/重复 ID/
  重启/截断），与带幂等窗口语义的参考模型端到端对拍。
- `go test -race ./...` 亦通过（3.413s）。
