集群控制器需要供调谐循环调用的Go队列库：同一对象按资源版本合并事件，失败按错误类别进入指数退避，删除墓碑必须越过旧更新，命名空间和全局令牌桶同时限速。用乱序 watch、取消与重新入队竞争验证每个版本至多交付一次且不会饿死冷命名空间。

## 用法

```go
q := formal.NewQueue(formal.Config{
	Global:    formal.RateLimit{Rate: 100, Burst: 20},
	Namespace: formal.RateLimit{Rate: 10, Burst: 2},
	Backoff: map[formal.ErrorClass]formal.Backoff{
		formal.ErrorClassTransient: {Base: 100 * time.Millisecond, Max: 30 * time.Second, Multiplier: 2},
		formal.ErrorClassConflict:  {Base: 250 * time.Millisecond, Max: 10 * time.Second, Multiplier: 2},
	},
})

for {
	event, ok := q.Get(ctx)
	if !ok {
		return
	}
	if err := reconcile(ctx, event); err != nil {
		q.Fail(event, err) // categorized exponential backoff
		continue
	}
	q.Done(event)
}
```

## 语义

- `Add` 只接受每个对象更高的 `ResourceVersion`；重复、旧版本和乱序到达的旧更新会被丢弃。同一版本最多进入一次正常交付。
- 每个对象同一时刻最多有一个在途事件。等待中的更新可被更高版本替换；等待中的更新可被删除墓碑替换。
- `Fail` 按 `ErrorClass` 选择退避策略；默认分类为 transient，也可用 `WithClass`、`ErrorClass()` 或 `errors.Is` 自定义。`ErrorClassTerminal` 不重试。失败重试是显式产生的再次交付。
- 删除墓碑会取消同对象仍在等待的旧更新及其退避延迟。已被 `Get` 取走的事件不会被强行抢占，但后续旧版本不会再次交付。
- 全局桶和命名空间桶必须同时有令牌才会交付；任一桶缺令牌时都不会消费另一个桶。就绪命名空间按轮转顺序调度。
- `Cancel` 可移除等待事件或作废在途租约。未交付版本取消后可重新入队；已交付版本仍保持去重。`Done`/`Fail` 使用取回事件中的租约拒绝过期完成。

## 验证

```sh
go test ./...
go test -race ./...
```

测试覆盖乱序 watch、重复与旧版本、墓碑越过退避、分类指数退避、双桶限速、冷命名空间轮转，以及取消/重入和 `Done`/重入竞态。
