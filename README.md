# 数据采集 CSV 方言的可恢复探测

接入服务调用可导入的 Go 包，在给定 CSV 候选方言中选出能够解释整份有限样本的方言。

## 用法

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0086"
)

func main() {
	sample := []byte("id,name\r\n1,\"alice\"\r\n")
	candidates := []dataeng.Dialect{
		{Delimiter: ',', Quote: true, LineEnding: dataeng.LF},
		{Delimiter: ',', Quote: true, LineEnding: dataeng.CRLF},
	}

	result := dataeng.Detect(sample, candidates, false)
	if !result.Valid {
		fmt.Print(result.DescribeErrors())
		return
	}
	fmt.Printf("candidate %d: %v\n", result.Index, result.Records)
}
```

`Detect` 的第三个参数表示样本末条是否可能被截断。也可以使用 `DetectSample` 传入 `Sample{Data: ..., Truncated: ...}`。`Select` 和 `Choose` 是 `Detect` 的别名，`Parse` 可单独解析一个方言。

## 语法与评分

- 候选方言由单字节分隔符、是否启用双引号及行尾 `LF`/`CRLF` 组成。
- 启用双引号时候选按引号字段解析；禁用时双引号是不能直接出现在字段中的保留字节。
- 双引号字段内以 `""` 表示一个引号字符；闭合引号后只能出现分隔符、对应行尾或样本结尾。
- 行尾只在引号外识别；引号内可跨物理行。截断样本的末条允许未闭合引号或半个尾部 `CRLF`。
- `Result.Records` 是半开字节区间 `[Start, End)`。完整记录包含行尾；EOF 处末条延伸到 `len(data)`。
- 截断末条不计入列数评分。评分按完整记录数、众数出现次数、众数列数从高到低比较；众数并列取较大列数，完全并列取候选序号较小者。
- 所有候选均非法时，`Result.Valid` 为 `false`，`Result.Candidates` 中逐候选保留最早错误的记录序号与字节偏移。

测试包含跨行双引号、末尾半个 `CRLF`、众数并列、候选有序号并列与全部候选失败的上报。
