# 排序归并连接重复组

ETL 引擎需要可导入的 Go sort-merge join 库，输入各自按复合键排序但可分块。重复键组可能超过内存，组件用可恢复 spill 产生笛卡尔组合且不丢顺序；null-safe 与普通等值模式分开。取消时清理本事务 spill，已提交批次保持。

## 用法

```go
left := dataeng.NewSliceSource(leftRows, 1024)  // 分块、按复合键排序
right := dataeng.NewSliceSource(rightRows, 1024)

j, _ := dataeng.NewJoiner(left, right, dataeng.Options{
    Mode:         dataeng.ModeInner, // 或 ModeNullSafe（NULL = NULL）
    MaxGroupRows: 4096,              // 单侧重复组内存上限，超出即 spill
    SpillDir:     "/var/tmp/spill",
})
defer j.Close() // 正常结束：清理全部 spill（含已提交批次）

for {
    p, err := j.Next(ctx) // 逐对返回，左主序，保持两侧输入顺序
    if err == io.EOF {
        break
    }
    // p.Key, p.Left, p.Right
}
```

## 语义

- **分块输入**：实现 `Source.NextChunk(ctx) ([]Row, error)` 即可接入任意分块源；`SliceSource` 为内置实现。输入乱序返回 `ErrUnsorted`。
- **重复组 spill**：单侧组行数超过 `MaxGroupRows` 时写入当前 spill 事务的磁盘文件；笛卡尔积由 `emitter` 逐对产出（左行 × 右组重扫），顺序不丢。
- **可恢复 spill**：`SpillReader.Offset()` 记录字节偏移，`OpenSpillReaderAt(path, off)` 从断点续读。
- **等值模式**：`ModeInner` 下含 NULL 的键永不匹配（整组跳过）；`ModeNullSafe` 下 NULL = NULL。
- **取消与提交**：每个键组一个 spill 事务，组内组合全部产出后 `Commit`（批次保留）；`Joiner.Abort()` 仅删除未提交事务的 spill，已提交批次保留在磁盘上；`Joiner.Close()` 正常清理全部。
