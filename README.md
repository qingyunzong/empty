# broadcast

Go 多订阅者广播库（仅标准库，泛型实现）。

## 语义

- **每订阅有界缓冲**：`New[T](capacity)` 为每个订阅分配独立缓冲。
- **满额淘汰**：发布时缓冲不足以容纳整批的订阅被单独淘汰，通道关闭，
  `Subscription.Err()` 返回 `ErrSlowConsumer`；其余订阅不受影响。
- **原子批次**：`Publish(values...)` 在持锁状态下先淘汰、后投递，容量已
  预留、发送不阻塞——对每个存活订阅要么整批接受、要么一条不投，绝不
  部分广播。广播器 `Close()` 后 `Publish` 返回 `ErrClosed`，全失败。
- **连续前缀**：每条消息携带全局单调递增 `Seq`（从 1 开始）。关闭与
  发布任意交错下，每个订阅收到的序号必然构成 `1..k` 连续前缀，
  订阅方可据此自检。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，2026-10-05。

```
$ go test ./... -v -count=1
=== RUN   TestEvictOnlyFullSubscriber
--- PASS: TestEvictOnlyFullSubscriber (0.00s)
=== RUN   TestOversizedBatchEvictsAll
--- PASS: TestOversizedBatchEvictsAll (0.00s)
=== RUN   TestPublishAfterClose
--- PASS: TestPublishAfterClose (0.00s)
=== RUN   TestContiguousPrefixUnderConcurrency
--- PASS: TestContiguousPrefixUnderConcurrency (0.01s)
=== RUN   TestUnsubscribe
--- PASS: TestUnsubscribe (0.00s)
=== RUN   TestSeqMonotonicAcrossBatches
--- PASS: TestSeqMonotonicAcrossBatches (0.00s)
PASS
ok  	broadcast	0.019s

$ go test -race ./... -count=1
ok  	broadcast	1.036s
```
