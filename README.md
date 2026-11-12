# 列式过滤器的空值逻辑

列式扫描宿主调用可导入的Go谓词编译包。模式声明列为可空int64或可空字符串，表达式支持常量、列引用、同类型比较=、<、<=、AND、OR、NOT和IS NULL；禁止隐式类型转换，编译时拒绝未知列和类型不符。比较任一操作数为null时结果为unknown；AND中false优先，OR中true优先，其余依三值逻辑，NOT保留unknown；过滤仅保留true行。输入批次由字典编码列组成，索引-1为null，其余指向字典值，允许字典中重复值；批次行数或索引非法时整批拒绝。直接在编码列上计算选择位图，允许短路但不得因此跳过批次结构校验；已编译表达式可并发复用。用解码后的逐行解释器比较随机嵌套表达式、全空列、重复字典与非法未访问列。

## 用法

```go
schema := dataeng.Schema{Columns: map[string]dataeng.ColumnType{
	"id":  dataeng.TypeInt64,
	"tag": dataeng.TypeString,
}}

expr, err := dataeng.Compile(schema, "id < 100 AND NOT tag IS NULL")
if err != nil {
	// 包装 ErrSyntax / ErrUnknownColumn / ErrTypeMismatch 之一
	log.Fatal(err)
}

batch := &dataeng.Batch{
	RowCount: 3,
	Columns: map[string]any{
		"id":  &dataeng.Int64Column{Dict: []int64{7, 200, 50}, Values: []int32{0, 1, -1}},
		"tag": &dataeng.StringColumn{Dict: []string{"a", "b"}, Values: []int32{0, -1, 1}},
	},
}
bitmap, err := expr.Evaluate(batch) // 结构非法时返回包装 ErrInvalidBatch 的错误
if err != nil {
	log.Fatal(err)
}
fmt.Println(bitmap.SelectedRows()) // [0]；unknown 与 false 行均被过滤
```

## 语义要点

- 三值逻辑：比较含 null 得 unknown；AND 中 false 优先，OR 中 true 优先，NOT 保持 unknown；仅 true 进入选择位图。
- 无隐式类型转换，例如 `int64 = string` 在编译期以 `ErrTypeMismatch` 拒绝。
- 批次先整体校验（缺失/错型列、索引越界、索引数与行数不一致），再求值；谓词未引用的列同样校验。
- 求值直接读取字典编码，不物化解码列；编译结果不可变，可被多个 goroutine 并发复用。

## 测试

`go test ./...`（可用 `-race`）。测试内置独立的解码后逐行参考解释器，对随机嵌套表达式、全空列、重复字典及非法未访问列做差分对比。
