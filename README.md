# 稀疏采集矩阵的重复观测归约

遥测接入宿主调用可导入的Go稀疏观测包，矩阵行列上限由调用方给定，越界事件使该批失败；事件含行列坐标、唯一ID和任意精度整数值，批内同坐标按事件ID字节序求最后值而非求和；显式删除值不等于数值零。可乱序接收批次，批次有单调版本，版本从1连续开始，旧版重投须内容相同；返回每版本规范CSR及原事件来源，缺版本暂存，不让后续覆盖尚未到达的版本。限制待处理批字节预算。以完整版本重放参考测试删后重加、重复事件和版本洞。

## 用法

```go
collector, _ := dataeng.NewCollector(
    64,                       // 行数上限
    32,                       // 列数上限
    1<<20,                    // 待处理批次字节预算
)

// 乱序提交：版本 2 先到，会被暂存，不产生快照
snapshots, err := collector.Submit(dataeng.Batch{
    Version: 2,
    Events: []dataeng.Event{
        {ID: []byte("evt-2"), Row: 0, Col: 1, Value: big.NewInt(42)},
    },
})

// 版本 1 到达后按 1、2 顺序连续提交，返回每个版本的规范 CSR
snapshots, err = collector.Submit(dataeng.Batch{
    Version: 1,
    Events: []dataeng.Event{
        {ID: []byte("evt-1"), Row: 0, Col: 1, Value: big.NewInt(7)},
        {ID: []byte("evt-del"), Row: 3, Col: 0, Delete: true},
    },
})

snapshot := snapshots[1].CSR
_ = snapshot.RowPtr  // Rows+1 的行指针
_ = snapshot.Columns // 按行、列排序的列索引
_ = snapshot.Values  // 任意精度整数；显式 0 保留
_ = snapshot.Sources // 每个值对应的原始事件 ID
```

## 语义要点

- 越界、空 ID、缺值、同 ID 冲突事件均使整批失败，不产生部分状态（`ErrOutOfBounds`、`ErrInvalidEvent`、`ErrDuplicateEvent`）。
- 同坐标多事件取事件 ID 字节序最大者的操作，不做求和；`Delete: true` 是显式删除，与存储数值 0 不同。
- 版本必须从 1 开始连续提交；缺版本期间后续批次进入暂存区并计入 `Batch.ByteSize()` 预算，超预算返回 `ErrBudgetExceeded`，到达顺序不允许覆盖未到版本。
- 已提交或已暂存版本重投时，内容哈希必须一致，否则返回 `ErrConflict`；一致的重投幂等返回已存快照（事件切片顺序不同但内容相同视为一致）。
- `Collector` 可并发使用；查询接口为 `NextVersion`、`PendingBytes`、`Snapshot`。

## 测试

```bash
go test -race ./...
```

参考测试 `TestFullVersionReplayReferenceScenario` 以完整版本重放覆盖删后重加、批内重复事件与版本洞；其余用例覆盖归约、显式零与删除、越界、重投冲突、字节预算、CSR 规范形状、任意精度整数往返和并发提交。
