# statlabels

基于标签树的事件统计库，仅使用 Go 标准库。

## 语义

- 标签组织为一棵树（`Tree`），删边后可退化为森林。
- 一条事件可打多个标签节点（`Stats.AddEvent`）。
- 祖先汇总去重：`Count` / `Contributions` 对每条命中事件只计一次，
  无论它命中子树内多少个标签。
- `DeleteEdge` 删除树边：子树整体脱离、归属改变，但事件上的原始
  标签不变（`Stats.Labels` 不受影响）。
- 贡献证据：`Contributions(node)` 逐事件列出 `MatchedLabels`，
  即该事件落在被汇总子树内的标签。
- 小树核对：`Verify(node)` 用独立路径（逐事件、逐标签沿父指针做
  可达性判断）重算，与主路径（子树集合交集）逐一比对。

## 测试结果

实际运行记录（go1.27.1 linux/amd64）：

```
$ go test ./...
ok  	statlabels	0.048s
$ go test -race -count=1 ./...
ok  	statlabels	1.133s
```

6 个测试全部通过，含 200 轮随机小树（随机加边/删边/加事件）的
逐事件可达性重算核对。
