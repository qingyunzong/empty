# stats：按用户维护最近 n 个事件中位数的统计库

仅使用 Go 标准库。

## 语义

- 每个用户（或其别名组）维护一份事件流，事件按 **(业务时间, ID)** 排序。
- 统计窗口为**最近 n 个事件**，取分数中位数；**偶数个取中间两项平均**。
- **更正**（`Upsert`）：同 ID 事件更新内容，所属用户变化时**迁移事件**到新属主。
- **变动快照**：每个变更操作返回受影响用户组的快照（组标识、成员、总数、窗口、中位数）。
- **别名组归并**（`Merge`）：多组合一，重组事件顺序；同 ID 副本**去重**（内容一致）
  或**隔离**（内容冲突，不参与统计，可经 `Isolated` 查询）。
- **拆分**（`Split`）：恢复到归并前的来源组，事件按属主回到原来源，
  归并前的**历史快照保持**不变。
- `Inject`：本地注入（不做全局更正），用于同一业务事件被多个别名各自上报的场景。

## 索引与原子性

`Store` 在同一把互斥锁内原子维护两类索引，对外不暴露中间状态：

- **归属索引**：`canon`，事件 ID -> 权威属主用户；
- **序统计索引**：每组按 (Time, ID) 升序的保留事件列表（二分插入/删除），
  中位数取列表尾部 n 项的分数。

同 ID 多副本的保留规则（归并/拆分/更正均遵循，且与全量重算等价）：
权威属主在组内时其副本保留，否则保留属主名字最小的副本；其余副本被抑制，
冲突判定相对当前保留事件的内容动态进行。

## 测试

`reference_test.go` 是不做任何增量索引的朴素参考实现：每次查询都从各用户
本地副本出发全量解析、全量排序。`stats_test.go` 以随机历史（更正/迁移、注入、
随机合拆、归并后立即拆分还原）逐步与参考模型对照快照与隔离列表，
并校验索引不变式；另有并发用例（`-race` 通过）。

实际运行结果（go1.27.1 linux/amd64）：

```
$ go test ./...
ok  	stats	0.932s

$ go test -v ./...
=== RUN   TestMedianWindow
--- PASS: TestMedianWindow (0.00s)
=== RUN   TestCorrectionMovesOwner
--- PASS: TestCorrectionMovesOwner (0.00s)
=== RUN   TestMergeDedupAndIsolation
--- PASS: TestMergeDedupAndIsolation (0.00s)
=== RUN   TestSplitRestoresSnapshots
--- PASS: TestSplitRestoresSnapshots (0.00s)
=== RUN   TestRandomAgainstFullSort
--- PASS: TestRandomAgainstFullSort (0.91s)
=== RUN   TestConcurrentAtomic
--- PASS: TestConcurrentAtomic (0.02s)
PASS
ok  	stats	0.932s

$ go test -race ./...
ok  	stats	5.409s
```
