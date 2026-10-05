# logcompact

仅使用 Go 标准库实现的日志压缩库：维护持久快照（snapshot）与活跃读者的
版本租约（lease），回收（truncate）不得越过任一仍需的记录。

## 设计

- `Log` 是追加式日志，记录带连续偏移量；`base` 之下为已回收部分。
- `PublishSnapshot` 持久化快照，钉住发布时 `base` 及以上的所有记录，
  直到 `DiscardSnapshot`。
- `Acquire(name)` 为读者发放租约，钉住当前全部留存记录。每个租约携带
  单调递增的 `Token` 标识其代际：`Release`/`Renew` 仅在 token 与同名
  当前租约一致时生效，因此**释放旧租约不会释放同名新租约**。
- `Truncate(upto)` 的实际回收边界被钳制到所有活跃快照与租约的最小
  仍需偏移量（retention floor），保证回收不越过任一仍需的记录。

## 测试

- `log_test.go`：追加/读取、无引用者时截断、快照与租约的钉住语义、
  旧租约释放/续租失效、2000 次并发旧租约释放与续租竞争。
- `model_test.go`：用可复用循环屏障（`barrier_test.go`）让快照发布、
  租约续租/释放与截断在三个 goroutine 中逐轮交错执行（3 个随机种子 ×
  500 轮），每轮与全量保留模型（full-retention oracle）对照校验两条
  安全不变式：回收未越过任何活跃引用者；留存记录与模型尾部逐条一致。

## 实际测试结果

环境：go1.27.1 linux/amd64。

```
$ go test ./...
ok  	logcompact	0.216s

$ go test -race -count=1 ./...
ok  	logcompact	1.727s
```

8 个测试（含 3 个种子子测试）全部通过，竞态检测器无报告。
