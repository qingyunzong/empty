# Modbus 轮询寄存器一致快照

工业采集器可以直接把 `ReadRange` 读取函数接入 `Coordinator`，由协调器按设备周期组合多个 Modbus 读区间。

```go
coordinator := dataeng.NewCoordinator(
	dataeng.RegisterReaderFunc(func(ctx context.Context, start, count uint16) ([]uint16, error) {
		return client.ReadHoldingRegisters(ctx, start, count)
	}),
	dataeng.WithMaxRetries(1),
)

snapshot, err := coordinator.Snapshot(ctx, dataeng.PollPlan{
	Cycle:           250 * time.Millisecond,
	Ranges:          []dataeng.ReadRange{{Start: 0, Count: 8}, {Start: 100, Count: 4}},
	RestartRegister: dataeng.Address(0),
})
```

## 一致性规则

- `Cycle`/`Period`/`DeviceCycle`/`Budget`/`Timeout` 中第一个非零值是一轮的总预算。所有区间、重试和重启计数复核都使用同一个绝对截止时间。
- 单个区间超时只重试该区间，已经成功读取的区间不会重读，重试也不会延长本轮预算。
- 重叠地址的值必须一致；任一冲突会返回 `ErrConflict`，整轮不发布快照。
- 每轮都从空映射开始合并。读取失败、超时或冲突时 `Snapshot` 返回 `nil`，不会回退或拼接上一轮的值。
- 配置重启计数寄存器后，计数变化会让 `Generation` 递增；首轮为第 1 代。若读取器随每个区间返回重启计数，同一轮内计数不一致会返回 `ErrGenerationChanged`。
- 读取器可使用 `ReadRange`、`ReadRegisters`、`(ctx, start, count)` 等常见形状；也可以直接调用 `CombineReadings` 复用冲突与完整性校验。
