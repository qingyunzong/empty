# CDC 主键更新成对归并

可导入的 Go 库：把同一事务、同一表 schema 世代中的 `delete + insert` 归并为一次主键迁移（旧键 → 新键），并原子地维护物化行状态。

```go
import dataeng "example.org/dataeng/q0237"

engine := dataeng.NewEngine()
result, err := engine.Apply(dataeng.Transaction{
    ID: "tx-42",
    Changes: []dataeng.Change{
        {
            Operation: dataeng.Delete,
            Table: "users", SchemaGeneration: 3,
            PrimaryKey: []string{"id"},
            Before: dataeng.Image{"id": 7, "email": "a@example.com"},
        },
        {
            Operation: dataeng.Insert,
            Table: "users", SchemaGeneration: 3,
            PrimaryKey: []string{"id"},
            After: dataeng.Image{"id": 8, "email": "a@example.com"},
        },
    },
})
// len(result.Migrations) == 1, From 为 id=7，To 为 id=8
```

## 归并规则

- 只在**同一事务**内配对；不同事务的 delete/insert 永不合并。
- 只配对**同一表、同一 schema 世代**的变更；迁移 ID 的身份包含世代。
- before/after image 必须提供至少一个非主键列作为证据，且两边所有非主键列都必须存在且值相等。只含主键的 image 视为证据不足。
- 配对必须是一对一且无歧义。多个 delete/insert 候选拥有相同证据时不猜测，保留为普通变更。
- 主键列由 `Change.PrimaryKey` 内联提供，或通过 `Engine.RegisterSchema` 按表 + 世代注册；注册的 `Columns` 会限定证据列。
- 主键迁移必须表达为 delete + insert。`Update` 修改主键会返回 `ErrKeyChangeInUpdate`。

## 唯一约束与原子性

插入目标键或迁移目标键如果已存在于事务开始时的状态，或已由本事务更早的变更产生，整笔事务返回 `ErrUniqueViolation`，行和 schema 均不发生任何变化。唯一性按表生效：即使 schema 世代不同，只要主键列和值相同也视为冲突。删除不会在同一事务内“腾出”一个可再次插入的键，从而拒绝有歧义的主键交换。

## 恢复重放

迁移 ID 由事务 ID、schema 世代和旧/新主键确定性生成。同一事务 ID 的相同内容再次应用时直接返回缓存结果，不会重复修改状态，迁移 ID 保持不变；相同 ID 配不同内容返回 `ErrTransactionConflict`。

`Engine.Snapshot` / `Engine.Restore`（以及 `NewEngineFromSnapshot`）可持久化 schema、行状态和事务重放账本，供进程重启后继续重放。

## 验证

```bash
go test ./...
go vet ./...
```
