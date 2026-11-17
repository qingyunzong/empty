# LSM 压实规划库

供后台压实器调用的 Go 库。`Planner` 从不可变状态快照中选择一个 `L -> L+1`
压实任务，在层级大小、键区间重叠、墓碑安全水位和并发占用约束下给出可行、
确定且写代价最小的输入文件集合。

```go
planner := compaction.NewPlanner(compaction.Config{
    MaxInputBytes: 1 << 30,
    MaxFiles:      32,
})
plan, err := planner.Plan(state)
if errors.Is(err, compaction.ErrNoPlan) {
    // 没有满足约束的任务，稍后重试。
}
if err == nil {
    if err := compaction.ValidatePlan(state, planner.Config(), plan); err != nil {
        // 执行前做一次独立复核。
    }
}
```

## 模型

- `File`：不可变表，含文件 ID、闭区间键范围、字节数、墓碑字节数和最新墓碑
  序号。同一层文件必须按 `Smallest` 排序且互不重叠。
- `Level`：`SizeLimit` 是触发压实的目标大小，零表示不限；`Number` 必须等于
  其在 `State.Levels` 中的下标。
- `RunningTask`：已运行任务的输入文件、键区间和目标层占用。区间未显式给出
  时由输入文件推导；无法推导时保守地占用整个键空间。
- `State.TombstoneWatermark`：最老活跃快照序号。仅当压实到最底层且墓碑序号
  `<= watermark` 时，该墓碑的字节可从输出估算中扣除。

## 选择规则

1. 只考虑越过 `SizeLimit` 的源层（可用 `PlanWithoutSizePressure` 放宽）。
2. 候选是源层中的连续键段，加上目标层中与该段相交的全部文件，即完整重叠
   闭包。
3. 默认选中足够的源层字节，使该层回到 `SizeLimit` 以内；`AllowPartial`
   或 `MinSourceBytes` 可改变这一下限。
4. 过滤 `MaxSourceBytes`、`MaxInputBytes`、`MaxWriteBytes`、`MaxFiles`、
   目标层大小、并发槽位以及与运行任务的文件/区间冲突。
5. 最小化 `WriteBytes = InputBytes - 可安全消除的墓碑字节`。这是未建模
   压缩和键去重时的保守写放大估计。

并列规则固定为：写字节少、输入字节少、文件数少、源层编号小、源文件 ID
字典序小、目标文件 ID 字典序小。结果不依赖 map 遍历顺序或运行任务顺序。

## 验证

`go test ./...` 包含针对性单测和 500 个固定种子的小规模组合穷举。穷举器独立
枚举每个源层、每个连续区间及每个结束位置，逐例校验：

- 计划结构与重叠闭包可行；
- 不占用运行中任务的文件或相交键区间；
- 墓碑、预算和目标层容量约束成立；
- `WriteBytes` 等于穷举得到的最小值，且并列选择一致；
- 同一输入重复规划得到完全相同的结果。
