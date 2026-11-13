# Flink checkpoint barrier 对齐

流处理运行时需要可导入的 Go barrier 对齐组件，为多输入算子缓存 barrier 后数据，支持 aligned、unaligned checkpoint 和取消标记。相同 checkpoint 只完成一次；后来的取消不能撤销已提交快照。通道恢复顺序须保证重放输出与无故障执行一致。

## 用法

```go
aligner, _ := dataeng.NewBarrierAligner(numInputChannels)

// 每条输入通道的记录与 barrier 按到达顺序驱动对齐器：
res, _ := aligner.ProcessRecord(channel, dataeng.Record{Value: v})
res, _ := aligner.ProcessBarrier(channel, dataeng.NewBarrier(id))          // aligned
res, _ := aligner.ProcessBarrier(channel, dataeng.NewUnalignedBarrier(id)) // unaligned
res, _ := aligner.ProcessBarrier(channel, dataeng.NewCancellation(id))     // 取消标记
```

- `Result.Emit`：需立即下游发射的记录，顺序与无故障执行一致。
- `Result.Snapshot`：checkpoint 完成时非空；同一 checkpoint ID 最多完成一次。
- aligned checkpoint 阻塞已报到通道并缓存其 barrier 后记录，完成或取消时按到达顺序释放。
- unaligned checkpoint 不阻塞记录，额外把 in-flight 记录捕获进 `Snapshot.Inflight`，恢复时按该顺序重放即可复现无故障输出。
- 已提交快照之后的取消标记会被忽略，无法撤销已完成的 checkpoint。
