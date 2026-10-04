# logcompact

版本化日志压缩库（仅 Go 标准库）。回收同时受两类钉住（pin）约束：

- **持久快照** `PublishSnapshot(name)`：钉住发布时的 head 版本；
- **读者租约** `AcquireLease(name)`：钉住活跃读者所需的最早版本，`Renew` 续租并把钉住版本推进到当前 head。

## 回收不变式

`Truncate` 计算水位 `horizon = min(所有存活 pin 的版本)`（无 pin 时为 `head+1`），
只压缩水位以下的记录（该前缀内每个 key 仅保留最新值），水位及以上的记录原样保留。
因此对任意存活 pin 的版本 `v`（`v >= horizon`）：

- `ScanFrom(v)` 与全量保留模型逐条一致（`v` 及以上记录未被触碰）；
- `StateAt(v)` 与全量保留模型一致（`v` 以下每 key 最新值被保留，恰好是
  截至 `v` 的压缩态）。

## 同名租约的代际隔离

每次 `AcquireLease` / `PublishSnapshot` / `Renew` 都签发新的代际 token
`(name, gen)`。`Release` / `Renew` 校验代际：用旧 token 释放同名租约返回
`ErrStaleToken`，不会误释同名的新租约/新快照。

## 测试

- `log_test.go`：水位计算、租约/快照共同约束回收、旧 token 释放/续租的
  代际隔离、无 pin 时仅保留每 key 最新值。
- `concurrency_test.go`：用屏障（`chan` + `WaitGroup` 会合点）强制快照发布、
  续租、截断同时起步，逐轮对照全量保留模型；另有单写者 + 多读者/快照/截断
  并发压力测试，结束后对所有存活 pin 与全量保留模型做全量对照。

## 测试结果（实际记录）

见 `TEST_RESULTS.txt`。
