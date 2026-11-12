# 嵌套记录模式中的独占分支验证

采集记录校验器要区分anyOf和oneOf，可导入的Go模式包供宿主导入。模式AST支持null、布尔、int64区间、字符串枚举、固定属性对象及数组，另支持anyOf、allOf、oneOf和命名引用；oneOf恰一分支通过，不能首个成功就结束。对象可声明必填及额外字段是否允许，数组有长度界限；模式引用可递归，验证值为有限无环JSON树。预先检查模式图，引用及anyOf/allOf/oneOf边构成的可达子图有环即拒绝；经对象字段或数组元素边下降后递归允许。失败返回值路径及分支判定树，以独立递归解释器核验。

## 用法

包路径为 `example.org/dataeng/q0168`，宿主通过 `Compile(root, defs)` 预先检查模式图，再调用 `Validate` 校验 JSON 树（`nil`、`bool`、整型、`float64`、`json.Number`、`string`、`[]any`、`map[string]any`）。

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0168"
)

func main() {
	min, max := int64(1), int64(10)
	defs := map[string]dataeng.Schema{
		"entry": &dataeng.Object{
			Properties: []dataeng.ObjectProperty{
				{Name: "id", Schema: &dataeng.Integer{Min: &min, Max: &max}},
				{Name: "kind", Schema: &dataeng.String{Enumeration: []string{"a", "b"}}},
			},
			Required:             []string{"id", "kind"},
			AdditionalProperties: false,
		},
	}

	validator, err := dataeng.Compile(&dataeng.Ref{Name: "entry"}, defs)
	if err != nil {
		panic(err) // *dataeng.SchemaError：未解析引用或 guard 边成环等
	}

	if failure := validator.Validate(map[string]any{"id": int64(3), "kind": "a"}); failure != nil {
		// failure.Path 为最深值路径（如 $.id），failure.Trace 为完整分支判定树。
		fmt.Println(failure.Error())
	}
}
```

## 语义要点

- `anyOf` 至少一个分支通过；`oneOf` 必须恰一分支通过，所有分支都会被求值，两个及以上匹配返回 `one_of_multiple_matches`。
- 编译期对 `Ref` 与 `anyOf`/`allOf`/`oneOf` 组成的 guard 边子图做环检测；对象字段、数组元素属于下降边，其后的递归引用合法。
- 失败时 `*Failure` 同时给出 JSONPath 风格的 `Path` 与 `Trace` 判定树，每个叶子节点带机器可读的 `Reason` 代码。
- 运行时对 map/slice 输入做活动节点检测，非有限无环的 JSON 树以 `cyclic_value` 拒绝。
