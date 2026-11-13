# 元组、键列与外部大字段

变更接入调用可导入的Go包重组元组，不连接数据库。同一条里可以有新元组、旧元组和键元组，键只含标识列。外部大字段先以标识出现，后续块按序号补齐；缺块的元组保持不可见。列类型以已经到达的关系描述为准，关系描述未到就出现元组则失败。用独立关系表核对键列、外部块和关系缺失，期望不得由被测包生成。

## 用法

```go
r := dataeng.New()

// 关系描述必须先到达；列类型和标识列均来自这里。
err := r.AddRelation(dataeng.Relation{
	ID:   11,
	Name: "accounts",
	Columns: []dataeng.Column{
		{Name: "id", Type: dataeng.TypeInt8, Identity: true},
		{Name: "name", Type: dataeng.TypeText},
		{Name: "body", Type: dataeng.TypeText},
	},
})

// 同一条里可以同时有 new、old 和 key；key 只能包含标识列。
events, err := r.IngestChange(dataeng.Change{
	Relation:  11,
	Operation: dataeng.Update,
	New: &dataeng.Tuple{Values: []dataeng.Value{
		dataeng.TextValue("2"),
		dataeng.TextValue("new name"),
		dataeng.ExternalValue("body-1"),
	}},
	Old: &dataeng.Tuple{Values: []dataeng.Value{
		dataeng.TextValue("1"),
		dataeng.TextValue("old name"),
		dataeng.TextValue("old body"),
	}},
	Key: &dataeng.Tuple{Values: []dataeng.Value{
		dataeng.TextValue("1"),
	}},
})

// new 元组引用了外部大字段，所以此时不可见。
// 外部块按序号补齐，序号从 0 开始；可以乱序到达，重复的相同块会被忽略。
events, err = r.IngestChunk(dataeng.ExternalChunk{
	ID: "body-1", Index: 0, Total: 2, Data: []byte("large "),
})
events, err = r.IngestChunk(dataeng.ExternalChunk{
	ID: "body-1", Index: 1, Total: 2, Data: []byte("body"),
})
// 最后一次块到达后，events 中才会出现完整变更。
```

`Tuple.Columns` 为空时，New/Old 按关系列顺序展开，Key 按标识列顺序展开。New 必须包含全部列；Old 可显式给出部分列；Key 显式给出时仍必须恰好覆盖全部标识列。

## 主要规则

- 关系缺失时 `IngestChange` 返回 `ErrRelationNotFound`，不留下待处理状态。
- 列值按到达时的关系快照校验；之后替换关系描述不会改变已待处理元组的类型。
- 缺少任一块的变更不会返回，`PendingChanges`/`PendingChunks` 可用于观察。
- 块序号从 0 开始，`Total` 必须为正数；块总数、格式或同一序号的数据冲突时返回 `ErrExternalConflict`。
- 完成后的外部值会保留以支持同一标识复用；可用 `EvictExternal` 主动释放。
- 未显式提供 Key 时，包会从 Old、再到 New 推导标识列，生成 `Event.Key`。
- 所有错误均可通过 `errors.Is` 判断。

## 测试

`go test ./...`。测试使用独立、字面量的关系表以及字面量期望行；期望值不由被测包的实现生成。
