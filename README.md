# 数据依赖的最小决定列发现

质量校验服务通过可导入的 Go 包 `dataeng` 从有限关系发现精确函数依赖 `X → a`。

## 语义

- 关系最多 `MaxColumns`（16）列；单元格为字符串或 `null`，`null` 是可相等的独立值（`null == null`，且与任何字符串不等）。
- 对每个目标列 `a`，枚举其余列的全部子集 `X`（空集允许）。若任意两行在 `X` 的每一列上相等，则它们在 `a` 上也必须相等，`X → a` 才成立。
- 仅返回最小左部：不存在 `X` 的真子集仍能决定 `a`。常量列的最小左部为空集 `[]`。
- 重复行不影响结论。
- 结果先按目标列升序、再按左部索引列表的字典序（升序列表，短前缀在前）排序。
- 每个被否决候选保留一对原始反例行号（零基索引）：两行在 `X` 上全等但在 `a` 上不同，取行优先扫描遇到的第一对。

## API

`Discover(rows Relation) (Report, error)` 返回最小依赖与全部否决候选：

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0076"
)

func main() {
	a, b := "a", "b"
	rows := dataeng.Relation{
		{&a, dataeng.NullCell()},
		{&b, dataeng.NullCell()},
	}
	report, err := dataeng.Discover(rows)
	if err != nil {
		panic(err)
	}
	fmt.Println(report.Dependencies)       // []dataeng.Dependency{{Target: 1, Left: []int{}}}
	fmt.Println(report.RejectedCandidates) // 含每个失败候选的反例行对
}
```

辅助入口：

- `FindFunctionalDependencies(rows)` / `FunctionalDependencies(rows)`：仅返回最小依赖列表。
- `StringCell(value)`、`NullCell()`、`Row(values...)`：构造单元格与行。

错误：列数超过 16 返回 `ErrTooManyColumns`，行宽不一致返回 `ErrRaggedRows`。

## 实现

- 对每个目标列做位掩码子集穷举（最多 2^15 个候选）。
- 逐行对比收集目标值不同的行对及其差异列掩码；候选 `X` 被否决当且仅当存在与 `X` 所选列互不相交的差异掩码。
- 反例行对按行优先顺序记录，并预计算每个候选的首个反例掩码，保证语义与朴素逐行扫描完全一致且结果确定。
- 利用依赖单调性（左部超集仍成立）与真子集校验筛出最小左部。
