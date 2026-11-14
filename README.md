# MySQL binlog row image 补全

`dataeng` 是一个无第三方依赖的 Go 包，用于把 MySQL binlog 的
`TABLE_MAP` / row event / transaction payload 归一化为完整行镜像。

## 能力

- `TABLE_MAP` 世代：同一逻辑表的布局变化会分配新 generation；table ID
  可复用，旧 generation 不会解码新行。
- `MINIMAL` row image：更新只包含变更列时，从同一 generation 的版本化
  前镜像补全未变更列。
- 缺列语义：缺失列通过 `MissingColumns` / `Reconstructable=false` 标记，
  绝不填零。SQL `NULL` 用 map 中存在的 `nil` 表示，与“未提供”严格区分。
- unsigned：按列宽重新解释补码，统一输出 `uint64`，不会把
  `BIGINT UNSIGNED` 的高位截断成负数。
- JSON partial update：支持 RFC 6902 风格操作、显式 `JSONDiff`、
  MySQL binary JSON diff，并在缺失 JSON 前值时把列标记为不可重建。
- transaction payload：按事件顺序应用 `TABLE_MAP`、row event 与 DDL，
  返回逐事件结果和首个错误。
- DDL：`ALTER`/`DROP`/`TRUNCATE`/`RENAME` 等立即失效旧 table map 并清除
  前镜像；新 `TABLE_MAP` 到达前，旧 table ID 上的行返回
  `ErrStaleTableMap`。

## 快速使用

```go
pipeline := dataeng.NewPipeline()

tm := dataeng.NewTableMap(7, "shop", "items", []dataeng.Column{
    {Name: "id", Type: dataeng.TypeBigInt, Unsigned: true},
    {Name: "name", Type: dataeng.TypeVarChar},
    {Name: "qty", Type: dataeng.TypeInt, Unsigned: true},
    {Name: "doc", Type: dataeng.TypeJSON, PartialJSON: true},
}, "id")

_ = pipeline.ApplyTableMap(tm)

_, _ = pipeline.NormalizeRow(dataeng.RowEvent{
    Type:    dataeng.RowInsert,
    TableID: 7,
    After: dataeng.RowImage{
        "id": uint64(1), "name": "one", "qty": uint64(3),
        "doc": map[string]any{"a": 1},
    },
})

row, _ := pipeline.NormalizeRow(dataeng.RowEvent{
    Type:    dataeng.RowUpdate,
    TableID: 7,
    Before:  dataeng.RowImage{"id": uint64(1)},
    After:   dataeng.RowImage{"name": "two"},
    AfterJSONDiffs: map[string]dataeng.JSONDiff{
        "doc": dataeng.NewJSONDiff(
            dataeng.JSONOperation{Op: "replace", Path: "$.a", Value: 2},
        ),
    },
})
// row.Reconstructable == true
// row.Row 同时包含补全后的 qty 与更新后的 doc
```

## 事务

```go
result, err := pipeline.ProcessTransaction(dataeng.Transaction{
    GTID: "gtid-1",
    Events: []dataeng.Event{
        tm,
        dataeng.RowEvent{ /* ... */ },
        dataeng.DDLEvent{Kind: dataeng.DDLAlter, Schema: "shop", Table: "items"},
    },
})
```

DDL 之后、新的 `TABLE_MAP` 之前到达的行会得到 `ErrStaleTableMap`；
`result.Errors` 保留每个事件的失败原因。
