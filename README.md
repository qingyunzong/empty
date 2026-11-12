# 向量化计算的选择掩码隔离

列式执行器通过Go条件算子包执行IF链，谓词与值表达式均由调用方注入，接收待计算行号集合并返回同长结果或逐行错误。按分支顺序仅对尚未命中的行求谓词，null谓词当false，选中行才求对应值；未选分支不得读取列或抛错。错误仅终止对应行，其他行继续；输出原行序及每表达式实际访问行号，不允许把已失败行送后续分支。用带访问计数和故障的逐行解释器核验稀疏掩码及分支短路。

## 用法

```go
rows := []int{7, 1, 42}

result := dataeng.Evaluate(rows, []dataeng.Branch{
	{
		Predicate: dataeng.Predicate{
			Name: "amount > 10",
			Eval: func(row int) (dataeng.Truth, error) {
				return dataeng.TruthOf(amount[row] > 10), nil
			},
		},
		Value: dataeng.Value{
			Name: "amount * 2",
			Eval: func(row int) (any, error) { return amount[row] * 2, nil },
		},
	},
}, dataeng.Value{
	Name: "else 0",
	Eval: func(row int) (any, error) { return 0, nil },
})
```

`result.Rows` 与输入行号一一对应且保持原顺序；成功行为 `Value`/`Null`，失败行为 `Err`。`result.Accesses` 按每个分支的谓词、值表达式及 ELSE 记录实际访问的行号，未求值表达式对应空列表。`dataeng.NullTruth()` 表示 null 谓词（按 false 处理），值表达式返回 nil 表示 null。
