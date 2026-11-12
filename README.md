# 变更采集的最小行镜像与主键交换

可导入的 Go 行镜像包，模块路径 `example.org/dataeng/q0240`，包名 `dataeng`。它把不可变的旧快照和一批 insert/update/delete 原子地合并为一份新的完整表。

## 快速使用

```go
schema, err := dataeng.NewSchema("ID", []dataeng.Column{
	{ID: "ID", Type: dataeng.TypeInt64},
	{ID: "Name", Type: dataeng.TypeBytes, Nullable: true},
	{ID: "Score", Type: dataeng.TypeInt64},
	{ID: "Note", Type: dataeng.TypeBytes, Nullable: true},
})

table, err := dataeng.NewTable(schema, []dataeng.Row{
	{
		"ID":    dataeng.Int64Cell(1),
		"Name":  dataeng.BytesCell([]byte("alpha")),
		"Score": dataeng.Int64Cell(10),
		"Note":  dataeng.NullCell(),
	},
})

batch := dataeng.NewBatch(
	// after 中省略 Score 和 Name，表示沿用旧行；显式 UnchangedCell 也沿用旧行。
	dataeng.UpdateOp(
		dataeng.Int64Cell(1),
		dataeng.Row{"Name": dataeng.BytesCell([]byte("alpha"))}, // before 可为部分旧镜像
		dataeng.Row{"Note": dataeng.BytesCell([]byte("changed"))},
	),
	// insert 必须给全列，不能出现 missing/unchanged。
	dataeng.InsertOp(dataeng.Row{
		"ID":    dataeng.Int64Cell(2),
		"Name":  dataeng.NullCell(),
		"Score": dataeng.Int64Cell(20),
		"Note":  dataeng.BytesCell([]byte("new")),
	}),
)

result, err := table.Apply(batch)
if err != nil {
	// 整批回滚；table 未被修改。
}

_ = result.Table   // 新的不可变快照
_ = result.Changes // 相对旧快照的净变化，按主键排序
_ = result.Applied // 按输入顺序展开的每条操作结果

for _, col := range []string{"Name", "Score", "Note"} {
	_, _ = result.Changes[0].Source(col) // SourceOld 或 SourceAfter
}
```

## 语义

- `Cell` 是标签联合：`CellMissing`（零值，表示省略）、`CellUnchanged`（显式未变）、`CellNull`、`CellInt64`、`CellBytes`。missing/unchanged 与 NULL 不同。
- `Schema` 固定每列类型和可空标志，并指定唯一非空主键列 `PrimaryKey`。快照行必须给全列，主键值唯一且非空。
- `Operation.OldID` 按批开始前的旧主键定位 update/delete；同一旧行在一批中最多被 update/delete 一次。
- `Before` 可省略；若给出，可以是部分镜像，但每个给出的字段必须与旧行逐值精确相等。未知列统一拒绝。
- update 的 `After` 可省略字段或给 `CellUnchanged`，两者都从旧行取值；显式具体值（包括 NULL）标记为 `SourceAfter`，其余标记为 `SourceOld`。
- insert 的 `After` 必须覆盖全部列，且不得含 missing/unchanged。
- 应用时先移除本批 update/delete 引用的旧行，再按输入顺序发布 update/insert 结果。因此支持两行交换主键、insert 复用本批删除的键；任何最终重复主键都会报 `ErrConflict` 而不是按到达顺序覆盖丢行。
- 任一未知列、缺旧行、坏 before、类型/可空性错误或最终主键冲突都会使整批失败，旧 `Table` 完全不变。
- `Result.Changes` 是旧表与新表的净差（按主键排序，无变化的 update 不出现）；`Result.Applied` 是按输入顺序的每操作展开结果。`Change.Sources` 为每个结果字段记录 `SourceOld`/`SourceAfter`。

## 验证

`apply_test.go` 使用独立的最终表模型覆盖主键交换、NULL 替换、部分 after 镜像、删键复用、跨操作冲突、批失败回滚和字节串主键；另验证旧快照及字节切片不会被调用方后续修改影响。

```sh
go test ./...
```
