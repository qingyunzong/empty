# formal: weighted multi-resource DRF

`formal` 是供队列调度器调用的 Go DRF（Dominant Resource Fairness）库：

- 多资源、多队列加权 DRF。队列份额为
  `max_r(queueUsed[r] / capacity[r]) / queueWeight`，任务份额再除以任务权重。
- 份额使用 `math/big.Rat` 精确表示，选择和抢占比较不经过浮点数。
- gang 原子：`Task.Demand` 是单个成员的请求，`GangSize` 个成员一次性全部预留，
  否则整个任务等待；不会被部分满足，也不会被部分抢占。
- 资源完整为 `int64` 单位（例如 millicores、MiB），避免小数容量带来的歧义。
- 自动抢占按稳定的主导份额顺序选择受害者：任务份额降序、队列份额降序、
  提交顺序升序、任务 ID 升序。只释放被选中的完整 gang，先记账再接纳，
  保证资源守恒且永不超过容量；候选人接纳后的预计队列份额高于受害者队列时
  不会反向抢占。
- 默认只在跨队列之间抢占；同队列抢占和等份额抢占可通过 `Options` 开启。

## 使用

```go
s, err := formal.NewScheduler(formal.Vector{"cpu": 8, "mem": 16})
if err != nil {
	panic(err)
}
_ = s.AddQueue(formal.Queue{ID: "batch", Weight: 1})
_ = s.AddQueue(formal.Queue{ID: "latency", Weight: 3})

_ = s.Submit(formal.Task{
	ID:       "train",
	QueueID:  "batch",
	Demand:   formal.Vector{"cpu": 1, "mem": 2}, // 每个成员
	GangSize: 3,                                 // 整组原子预留
})

decision, err := s.Allocate()
```

`Allocate` 一直调度到不动点；`AllocateOne` 每次只做一个接纳（可能先做一组抢占），
适合事件驱动的分配序列。`Preempt`/`Complete`/`Cancel` 用于显式事件，
`Snapshot`、`QueueShare`、`TaskShare`、`Validate` 用于观测和校验。

队列或任务权重 `0` 归一为 `1`，负权重会被拒绝。若集群无法容纳完整 gang，
任务会保持等待并在 `Decision.Reasons` 中说明原因。

## 验证

测试覆盖：

- 精确主导份额、加权份额、平局资源选择；
- 加权队列按 1:2 份额分配；
- gang 部分可容纳时仍等待，释放后整组接纳；
- 抢占顺序、完整 gang 抢占与资源账本守恒；
- 5 个任务的全部 120 种提交顺序，分别以批量与逐次到达两种方式，
  与独立的朴素 DRF 参考实现逐任务、逐队列比对资源和份额；
- 小集群上 5 层到达/调度/抢占/完成事件的全量交错穷举，以及固定种子的
  长序列随机交错，逐步执行 `Validate` 检查不超配。

运行：`go test ./...`，竞态检查：`go test -race ./...`。
