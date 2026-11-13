# SNMP GetBulk 表遍历

`dataeng` 是一个可导入的 Go SNMP 表遍历库。它把多列 GetBulk 响应整理成按实例索引对齐的行，并隔离代理异常对其它列的影响。

## 使用

实现 `BulkClient`，把请求交给现有的 SNMP 传输层：

```go
type BulkClient interface {
	GetBulk(ctx context.Context, oids []OID, nonRepeaters, maxRepetitions int) ([]VarBind, error)
}
```

也可以用 `BulkClientFunc` 或 `BulkFunc` 适配函数。

```go
columns, err := dataeng.ParseOIDs([]string{
	".1.3.6.1.2.1.2.2.1.2", // ifDescr
	".1.3.6.1.2.1.2.2.1.3", // ifType
	".1.3.6.1.2.1.2.2.1.10", // ifInOctets
})
if err != nil {
	return err
}

table, err := dataeng.WalkTable(ctx, client, columns,
	dataeng.WithMaxRepetitions(25),
)
if err != nil {
	// 发生传输错误时仍会返回已采集到的部分表。
	return err
}

for _, row := range table.Rows {
	fmt.Printf("index %s\n", row.Index)
	for i := range table.Columns {
		if value, ok := row.Value(i); ok {
			fmt.Printf("  %s = %v\n", table.Columns[i], value)
		} else {
			fmt.Printf("  %s = <missing>\n", table.Columns[i])
		}
	}
}
```

## 行为

- 多列 OID 按列各自推进；某一列结束后，只从后续请求中移除该列。
- 行按实例索引（列 OID 后的后缀）排序并对齐。某列缺少该索引时，`Row.Cells` 仍保留该列位置，`Present` 为 `false`，并保留 `ColumnIndex` 与 `Column`（空值来源）。
- `endOfMibView`、`noSuchObject`、`noSuchInstance` 都会结束对应列；空 OID 的终止响应通过 GetBulk 响应位置归因到对应列。
- 同列 OID 不递增时立即结束该列。重复响应不会生成重复行或覆盖已有值，因此重试是幂等的。
- 代理返回列前缀之外的越界 OID 时，按响应位置和 OID 字典序间隙终止对应列，不影响其它列。
- `non-repeaters` 和 `max-repetitions` 会原样传给每次 GetBulk；`non-repeaters` 会按当前仍在推进的列数截断。
- 空响应或没有任何进展的响应会终止遍历，避免死循环。`WithMaxRequests` 可额外设置请求数硬上限。

## 主要 API

- `WalkTable` / `Walk`：遍历入口。
- `WalkOptions`：`NonRepeaters`、`MaxRepetitions`、`MaxRows`、`MaxRequests`。
- `WithNonRepeaters`、`WithMaxRepetitions`、`WithMaxRows`、`WithMaxRequests`：选项函数。
- `OID`、`ParseOID`、`ParseOIDs`、`VarBind`、`Table`、`Row`、`Cell`。

`Table.ColumnValues(i)` 返回与 `Table.Rows` 对齐的列值切片，缺失值为 `nil`。
