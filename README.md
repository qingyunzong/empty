# 列批接入时字典代际的冻结

数据交换宿主收到 schema、dictionary 和 batch 消息，需要一个可导入的 Go 重放包。本模块实现单流重放：字典按代际冻结为不可变快照，批次按自己声明的代际解释索引；批次可以先于字典到达，后续替换不会改变已经返回的批次。

## 快速使用

```go
package main

import (
	"fmt"

	"example.org/dataeng/q0186"
)

func main() {
	stream := dataeng.NewStream()

	_ = stream.Apply(dataeng.NewSchema(
		dataeng.Column{Name: "id", Type: dataeng.TypeInt},
		dataeng.Column{Name: "tag", Type: dataeng.TypeString, DictionaryID: "tags"},
	))

	// The batch may arrive before the dictionary it names.
	results, err := stream.Feed(dataeng.NewBatch(
		map[string]int{"tags": 2},
		dataeng.ColumnBatch{Name: "id", Values: []int{10, 11}},
		dataeng.NewColumnBatch("tag", []int{0, 1}),
	))
	fmt.Println(results, err) // no result yet, no error

	_ = stream.Apply(dataeng.NewDictionary(
		"tags", 1, dataeng.DictionaryReplace, "cold",
	))
	_ = stream.Apply(dataeng.NewDictionary(
		"tags", 2, dataeng.DictionaryAppend, "hot",
	))

	// Generation 2 is ["cold", "hot"], so this is "cold"/"hot".
	results, err = stream.Drain()
	for row, record := range results[0].Rows {
		fmt.Println(row, record)
	}
}
```

`dataeng.Replay(messages...)` is the all-at-once form and returns every decoded batch. `Stream.Feed` returns batches made ready by one message; `Stream.Apply` queues them for `Drain`/`Next`. The `replay` subpackage re-exports the same API.

## 消息模型

- `SchemaMessage`：必须是第一条消息且只能出现一次。`Column` 用 `Type` 声明类型，用 `DictionaryID`（或 `DictID`）声明字典列。
- `DictionaryMessage`：`ID`、`Generation`、`Mode`（`replace` 或 `append`）、`Values`。`Replace`/`Append` 布尔字段是便捷别名。
- `BatchMessage`：`Generations` 为每个引用字典声明所需代数（也可写 `RequiredGenerations`/`DictionaryGenerations`）。`Columns` 可接受 `[]ColumnBatch`、按列名索引的 map 或 `Rows`。字典列给 `Indices`，`-1` 表示 null；普通列给 `Values`。

`ColumnBatch` 的输入切片支持 `[]int`、`[]int64`、`[]string`、`[]any` 等常见写法。JSON 对象/JSON 字节串可以直接交给 `Stream.Feed`，其中 `"type"` 或 `"kind"` 取 `schema`、`dictionary`、`batch`。

## 语义保证

- 第一条非 schema 消息、第二条 schema、未声明字典或列都会报错；schema 在流内不变。
- 字典首代必须为 1。同 ID 代数连续递增；缺号更新先暂存，缺号补齐后按顺序应用。
- 整替换在新代际生成完整快照；追加以前一代快照为前缀，只生成新快照，不改旧项。
- 同一 `(ID, Generation)` 重投相同内容幂等；重投不同内容返回 `*GenerationConflictError`，状态不变。
- 批次可以引用尚未到达的字典代际。它按到达顺序等待，不会因为后续字典更新而改变解释基准。
- 索引 `-1` 解码为 `nil`。小于 `-1` 或超出该代快照长度的索引使该批次返回 `*BatchError`/`*DictionaryIndexError`，字典本身不受影响，后续批次仍可重放。
- `Result` 中的列值是从快照复制出来的；已返回批次不随后续 replace/append 改变。
- `Close` 会报告仍未满足的批次和字典缺号。

运行测试：

```sh
go test ./...
go vet ./...
```
