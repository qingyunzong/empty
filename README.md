# 小文件压实并发隔离

数据湖维护服务需要可导入的 Go compaction 状态组件，选择同分区且未被其他计划占用的文件，生成替换集合。计划基于 snapshot id，提交时验证输入仍活跃；并发压实有交集时仅一个成功。失败输出不进入 manifest，并保存可安全回收清单。

## 组件概览

包 `dataeng` 提供可导入的 `Manager`，在内存中维护 manifest、snapshot 历史、压实计划注册表与可安全回收清单，全部方法通过 `sync.RWMutex` 保证并发安全。

### 核心保证

- **同分区选择 + 占用隔离**：`PlanCompaction` 仅选择同一 `Partition` 下处于活跃状态、且未被其他 open 计划 claim 的文件，生成 `ReplacementSet`（输入集合）。已被占用的文件会被跳过；不足 `MinFiles`（默认 2）时返回 `ErrNothingToCompact`。
- **基于 snapshot id**：每个计划记录 `BaseSnapshotID`，即规划时的当前 snapshot。
- **提交期乐观并发控制（OCC）**：`Commit` 先做全部校验，再原子应用替换集合。若任一输入文件已不活跃（例如另一个有交集的压实先提交），返回 `ErrConflict` 且不改任何状态，计划仍保持 `planned` 可重试。因此有交集的并发压实恰好一个成功。
- **失败输出隔离**：`Fail` 将作业产物作为 `failed-output` 加入回收清单（`Immediately=true`、`SnapshotID=0`），它们从不进入 manifest；同时释放输入 claim 以便重新规划。
- **可安全回收清单**：被替换的输入以 `replaced-input` 入清单（受 snapshot 过期保护，`Immediately=false`）。垃圾回收删除物理文件后调用 `AcknowledgeRecycled` 幂等清理。

### 计划生命周期

`planned` →（`Commit`）`committed`；`planned` →（`Fail`）`failed`；`planned` →（`Abort`）`aborted`。终态计划不可再次提交，否则返回 `ErrPlanNotOpen`。

### 典型用法

```go
m := dataeng.NewManager()
m.Append(inputA, inputB)

plan, err := m.PlanCompaction("p", dataeng.PlanOptions{})
// ... 物理压实产出 output ...
result, err := m.Commit(plan.ID, []dataeng.DataFile{output})

// 作业失败时：output 不进入 manifest，只进入回收清单
m.Fail(plan.ID, partialOutputs)

for _, item := range m.RecycleList() {
    // 删除 item.Path 后
    m.AcknowledgeRecycled(item.Path)
}
```

`PlanOptions.NoClaim` 可关闭 claim（接入外部锁管理器时使用）；此时提交期 OCC 仍然保证有交集的压实只有一个成功。

## 文件结构

- `manager.go`：`Manager`、文件索引、snapshot 与 manifest 读取、claim 查询。
- `plan.go`：`PlanCompaction` / `Commit` / `Fail` / `Abort` 与计划查询。
- `recycle.go`：安全回收清单查询与确认。
- `types.go`：领域类型与生命周期常量。
- `errors.go`：可通过 `errors.Is` 判定的哨兵错误。
- `*_test.go`：单元测试、并发（`-race`）测试与可运行示例。
