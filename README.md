# formal：事件时间窗口组件

流计算引擎供算子运行时调用的 Go 窗口组件，处理事件时间水位、允许迟到、
会话窗口合并和撤回更新。水位只增不减；合并后旧定时器失效但状态与计数不丢；
用乱序事件和故障恢复重放验证输出变更与朴素全历史计算一致。

## 组件

无外部依赖，包名 `formal`。

- `WatermarkGenerator`：有界乱序水位，`Observe`/`Advance` 均保证水位只增不减。
- `TumblingAssigner` / `SessionAssigner`：滚动窗口与会话窗口分配（支持负时间戳的数学整除）。
- `WindowOperator`：核心算子，通过 `Process(Signal)` 接收事件或水位，输出 `Change` 变更流。
  - 事件时间定时器（最小堆）在窗口结束触发输出，在 `结束+允许迟到` 清理状态。
  - 迟到判定：`eventTime + allowedLateness < watermark` 的事件被丢弃并计入 `DroppedLateEvents`。
  - 已发出结果的窗口收到迟到更新时先发 `Retract` 再发 `Add`，下游可直接 fold 成物化视图。
  - 会话合并采用区间重叠的定点闭包：合并时旧窗口定时器全部失效、合并窗口重新注册；
    已发出的旧行撤回、合并行重发，count/sum 守恒。
- `FoldChanges`/`ViewRows`：把变更流折叠为物化视图。
- `Snapshot`/`Restore`：gob 序列化水位、窗口状态、定时器与变更日志，用于故障恢复重放。
- `NaiveOracle`：朴素全历史参考实现，从头重算窗口结果，测试中与算子输出逐条对照。

## 用法示例

```go
op := formal.NewWindowOperator(formal.NewSessionAssigner(10), 3)
op.Process(formal.Signal{Event: formal.Event{ID: "a", Timestamp: 0, Value: 1}})
op.Process(formal.Signal{IsWatermark: true, Watermark: 10})
view := formal.FoldChanges(op.Changes()) // 触发后物化视图含 [0,10) 的聚合行

data, _ := op.Snapshot()             // 故障点快照
recovered, _ := formal.Restore(data) // 恢复后继续 Process，变更流与无故障运行完全一致
_ = view
```

## 验证

`go test ./...` 覆盖：水位单调性、滚动窗口撤回与允许迟到、会话合并后旧定时器失效与状态守恒、
快照往返、多个检查点的故障恢复重放，以及多组随机乱序输入下算子结果与 `NaiveOracle`
全历史重算一致（含每步物化视图一致性与事件守恒不变量）。`go test -race ./...` 干净通过。
