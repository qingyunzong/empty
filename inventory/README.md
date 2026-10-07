# inventory

按稳定物品 ID 管理的拆箱/合箱库存库（Go）。

## 特性

- **稳定物品 ID**：`ItemID` 全程不变，每个物品在任意时刻恰好属于一个箱子，由库强制保证。
- **规则即输入**：`Rules{Capacity, IncompatibleGroups}` 在创建 `Inventory` 时传入，容量与禁混（按物品分组）规则在每次提交时校验。
- **事务原子性**：`Begin()` 累积 `CreateBox / RemoveBox / Put / Move / Remove` 操作，`Commit()` 先在状态副本上整体校验并应用；任一操作失败则整个事务无任何变更。
- **拆箱合箱**：`Split(src, dst, ids)` 与 `Merge(src, dst)` 是事务的便捷封装；合箱后空箱保留（`RemoveBox` 仅允许删除空箱）。
- **可重放履历**：每个已提交事务记录为可 JSON 序列化的 `Tx`；`History()` / `MarshalHistory()` 导出，`Replay` / `ReplayJSON` 在相同规则下重放可重建完全一致的状态。
- **随机化核验**：`random_test.go` 用独立参考模型（物品归属表）对随机操作序列逐步交叉核验，并校验容量、禁混、唯一归属等不变量及履历重放一致性。

## 示例

```go
inv := inventory.New(inventory.Rules{
    Capacity:           3,
    IncompatibleGroups: [][2]inventory.Group{{"food", "chemical"}},
})

tx := inv.Begin()
tx.CreateBox("b1")
tx.CreateBox("b2")
tx.Put(inventory.Item{ID: "apple", Group: "food"}, "b1")
tx.Move("apple", "b2")
if err := tx.Commit(); err != nil {
    // 整体无变更
}

_ = inv.Split("b2", "b3", []inventory.ItemID{"apple"})
_ = inv.Merge("b3", "b1")

data, _ := inv.MarshalHistory()
clone, _ := inventory.ReplayJSON(inv.Rules(), data)
```

## 测试

```sh
go test ./...
```
