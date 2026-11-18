# 可嵌入的实例发现聚合库

`example.org/dlks/formal/q10053` 是一个并发安全的 Go 实例发现聚合库，用于把健康检查、权重更新、连接池排空和成员变更事件合并成一张确定的实例表。

## 能力

- 同一实例的多次观察按 `(Generation, Revision)` 去重；旧代际、旧版本和重复事件不会覆盖新状态。
- 健康、权重、排空、成员关系是四个独立方面，各自按 revision 做 last-writer-wins，因此不同观察源可以使用独立序号。
- `DrainDraining` 保留实例但禁止分配新请求；`DrainDrained` 和 `Remove` 会让实例离开存活集合。
- 重连必须递增 `Generation`。新代际从健康未知、默认权重、非排空状态开始，旧连接迟到的健康/排空/删除事件会被忽略，不会产生幽灵实例。
- 提供的加权选择只考虑“存活 + 健康 + 非排空 + 权重为正”的实例。
- 读接口返回排序后的值快照，可在并发写入期间安全调用。

## 快速使用

```go
package main

import (
	"fmt"

	formal "example.org/dlks/formal/q10053"
)

func main() {
	a := formal.New() // 默认权重为 1

	a.Apply(formal.HealthEvent("api-1", 1, 1, formal.HealthHealthy))
	a.Apply(formal.WeightEvent("api-1", 1, 1, 3))

	a.Apply(formal.HealthEvent("api-2", 1, 1, formal.HealthHealthy))
	a.Apply(formal.DrainEvent("api-2", 1, 2, formal.DrainDraining))

	for _, instance := range a.Available() {
		fmt.Println(instance.ID, instance.Weight)
	}

	id, ok := a.Select(0) // 确定性加权选择；Pick 接受 *rand.Rand
	fmt.Println(id, ok)
}
```

输出：

```text
api-1 3
api-1 true
```

## 事件与状态规则

每个 `Event` 都包含：

| 字段 | 含义 |
| --- | --- |
| `ID` | 实例标识 |
| `Generation` | 连接/实例代际，重连时必须递增 |
| `Revision` | 当前代际内该事件方面的单调序号 |
| `Kind` | `health`、`weight`、`drain`、`add`、`remove` |

合并规则：

1. `Generation` 更小的事件直接忽略；更大的代际会重置该实例的全部方面。
2. 同一代际内，每个方面分别保留 revision 最大的观察。
3. revision 相同视为重复；若生产端错误地给出不同值，按固定规则合并，保证任意到达顺序得到相同结果：unhealthy、draining/drained、removed 优先，权重取较大值。
4. `DrainDrained` 或 `Remove` 是方面内的最新观察，实例不被选中；之后只有同代际更高 revision 的显式 `DrainActive`/`Add` 或更高代际事件可以恢复它。

存活集合 `Snapshot()` 包含健康、未知健康、排空中的实例；不包含 drained/removed 实例。可用集合 `Available()` 进一步要求：

```text
present && drain == active && health == healthy && weight > 0
```

## 并发与复杂度

- `Aggregator` 使用 `sync.RWMutex` 保护内部表，可被多个 goroutine 同时读写。
- `Apply` 为 O(1)。
- `Snapshot`/`Available` 为 O(n log n)，返回独立副本并按 ID 排序。
- `Select`/`Pick` 为 O(n log n)，每次调用只观察一个一致的表快照。
- 零值 `Aggregator` 可直接使用；但首次使用后不可复制。

## 验证

测试包含独立的“朴素实例表”批量重算 oracle：每应用一个事件后，都从完整事件日志重新计算存活集合、可用集合和权重总和，并与增量聚合结果比较。

覆盖方式：

- 17 类健康/权重/排空/删除/旧代际/重连事件，穷举长度 0 到 4 的全部序列。
- 重连、排空、健康检查交错 fixture 的全部 40,320 种到达顺序。
- 固定种子长序列随机抖动与重复事件。
- Go fuzz 目标的种子语料，以及 `go test -race` 并发读写/选择测试。

```bash
go test ./...
go test -race ./...
```
