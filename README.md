# 事件时间窗口组件

`dataeng` 是一个可直接嵌入 Go 流处理任务的事件时间窗口组件。它支持
tumbling、sliding、session 三类窗口，按分区维护多源水位，提供带版本的迟到修订、
侧输出，以及可重放一致触发顺序与版本号的快照恢复。

## 快速开始

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0101"
)

func main() {
	cfg := dataeng.Config{
		Window:          dataeng.Sliding(10_000, 5_000),
		AllowedLateness: 2_000,
		Aggregate: func(_ dataeng.WindowContext, events []dataeng.Event) any {
			return len(events)
		},
	}

	op, err := dataeng.NewOperator(cfg)
	if err != nil {
		panic(err)
	}

	// 记录只进入窗口状态，不会隐式推进水位。
	results, sides, err := op.Process(dataeng.Event{
		Partition: "p0", Source: "orders", Key: "k1",
		Timestamp: 1_200, Value: []byte("a"),
	})
	_ = results
	_ = sides
	if err != nil {
		panic(err)
	}

	// 每分区水位 = 所有活跃源水位的最小值。
	if _, err := op.AdvanceWatermark("p0", "orders", 10_000); err != nil {
		panic(err)
	}

	// 显式空闲心跳让该源退出活跃集合，不再约束分区水位。
	if _, err := op.Heartbeat(dataeng.Heartbeat{
		Partition: "p0", Source: "legacy", Idle: true,
	}); err != nil {
		panic(err)
	}

	// 保存并在另一个算子中恢复。
	snapshot, err := op.Snapshot()
	if err != nil {
		panic(err)
	}
	restored, err := dataeng.NewOperator(cfg)
	if err != nil {
		panic(err)
	}
	if err := restored.Restore(snapshot); err != nil {
		panic(err)
	}
	fmt.Println("restored")
}
```

## 窗口语义

- Tumbling：`Tumbling(size)`，窗口为 `[k*size, (k+1)*size)`。
- Sliding：`Sliding(size, slide)`，窗口起点为 `slide` 的整数倍，覆盖 `ts` 的每个
  窗口都会收到记录。`size < slide` 时窗口之间存在空洞，落入空洞的记录进入
  `SideOutputNoWindow` 侧输出。
- Session：`Session(gap)`。每个 `(partition, key)` 维护多个不重叠会话；记录与
  `[start, end]` 相交、或与任一端相距不超过 `gap` 时合并。边界相等仍视为同一
  会话。会话窗口输出的 `End = 最后一条记录时间 + gap`。
- 所有窗口区间按半开区间 `[Start, End)` 展示；事件时间戳等于 `End` 时属于下一个
  固定窗口。

## 水位与空闲源

```go
op.AdvanceWatermark("p0", "source-a", 100)
op.AdvanceWatermark("p0", "source-b", 90)   // 分区水位 = min(100, 90) = 90
op.MarkIdle("p0", "source-b")                // 分区水位推进到 100
op.Heartbeat(dataeng.Heartbeat{
	Partition: "p0", Source: "source-b", Timestamp: 120, Idle: false,
})                                           // 显式重新激活
```

- 分区水位只取该分区内非空闲、已知水位源的最小值。
- `Heartbeat{Idle: true}` 或 `MarkIdle` 是显式退出方式；不会因为一段时间没有记录
  而自动判定空闲。
- 新加入或重新激活的源如果落后于分区当前水位，会被快进到分区水位，保证水位和
  触发顺序不倒退。
- 所有源都空闲时保留最后一次分区水位，不继续推进。
- 没有水位时记录只缓存，不触发窗口。

## 迟到修订与侧输出

```go
results, sides, err := op.Process(ev)
```

- 分区水位到达 `Window.End` 时首次触发，版本号为 `1`，`Late == false`。
- 在 `Window.End + AllowedLateness` 之前到达的迟到记录会立即产生新版本；版本号
  按窗口单调递增，`Late == true`。
- 水位到达 `End + AllowedLateness` 后窗口状态被丢弃；之后命中该窗口的记录进入
  侧输出，`Reason == SideOutputAfterDeadline`。
- 会话窗口合并多个已触发会话时，新版本号为参与合并会话最大版本号加一。
- 关闭窗口不会额外发送一条“空 final”消息；最后一条版本就是最终版本，侧输出
  负责暴露超期记录。

`WindowResult.Events` 保存该版本完整的事件集合，便于下游重算聚合；
`Aggregate` 回调也接收同一集合的副本。

## 恢复一致性

```go
snap, err := op.Snapshot()
restored, _ := dataeng.NewOperator(cfg)
err = restored.Restore(snap)
```

- 快照包含分区与源水位、空闲标记、未触发窗口、已触发窗口的版本号、会话合并
  状态和已关闭会话边界。
- 快照在方法调用之间获取；所有输出都是同步返回的，不存在隐式待发送队列。
- 同一状态下重复 `Snapshot` 产生稳定字节序列（`Event.Value` 使用 gob 可稳定编码
  的类型时）。
- 恢复时窗口类型、大小/滑动步长/会话间隔和允许迟到时长必须一致。
- 触发顺序固定为 `(窗口结束, 窗口开始, partition, key, version)`，恢复后继续
  使用同一顺序。
- `Event.Value` 为结构体、map、slice 等自定义类型时，需要先调用
  `dataeng.RegisterEventValue(value)`；在全新进程中恢复也要在执行 `Restore`
  前注册。

## 主要 API

| API | 说明 |
| --- | --- |
| `NewOperator(Config)` | 校验配置并创建空算子 |
| `Tumbling/Sliding/Session` | 构造窗口规格 |
| `Process(Event)` | 摄入记录，返回窗口修订与侧输出 |
| `ProcessBatch([]Event)` | 批量摄入并按窗口顺序返回修订 |
| `AdvanceWatermark(partition, source, ts)` | 推进单源水位 |
| `Heartbeat(Heartbeat)` | 推进水位或显式标记空闲 |
| `MarkIdle(partition, source)` | 源退出活跃集合 |
| `Watermark(partition)` | 查询分区水位 |
| `Sources(partition)` | 查询各源水位与空闲状态 |
| `Snapshot()/Restore([]byte)` | 状态持久化与恢复 |
| `RestoreOperator(Config, []byte)` | 冷启动时创建并恢复算子 |

算子不是并发安全的；由拥有该分区状态的流任务串行调用即可。

## 测试

```bash
go test ./...
go vet ./...
```
