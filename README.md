# 近重复采集记录的约束聚类

同一网页的多份采集结果可能互相相似却有禁止合并标记。为去重宿主提供可导入的Go聚类包：至多12条记录，给定每对有符号整数合并收益，未提供的收益为零；及must-link、cannot-link约束，分区得分为同组记录对收益之和，求合法分区最大得分；并列将各组ID排序后取组列表字节序最小者。must-link须传递，不能用逐边贪心形成非法组；返回每组依据及无解约束链。用全部集合分区核对负收益、约束环和并列。

## 使用

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0141"
)

func main() {
	result, err := dataeng.Cluster(dataeng.Input{
		Records: []int{10, 20, 30},
		Benefits: []dataeng.PairBenefit{
			{A: 10, B: 20, Benefit: 8},
			{A: 20, B: 30, Benefit: -3},
		},
		MustLinks: []dataeng.Constraint{{A: 20, B: 30}},
		CannotLinks: []dataeng.Constraint{{A: 10, B: 30}},
	})
	if err != nil {
		panic(err)
	}
	for _, group := range result.Groups {
		fmt.Printf("ids=%v score=%d basis=%+v\n", group.IDs, group.Score, group.Basis)
	}
	fmt.Printf("total=%d\n", result.Score)
}
```

`Solve` 和 `Partition` 是同一算法的位置参数便捷入口。

## 语义

- 记录 ID 必须唯一；收益按无向记录对给出，未给出的记录对收益为 0。
- must-link 取传递闭包，形成不可拆分的原子；禁止边与闭包冲突时返回 `ErrUnsatisfiable`。
- 分区得分是所有同组无向记录对收益之和，负收益也参与计算；单条记录不产生自配对收益。
- 最优分区使用精确枚举，复杂度为 `O(Bell(k))`，其中 `k` 是闭包后的原子数，`k <= 12`。
- 并列时：组内 ID 升序、组按最小 ID 升序，然后按组列表字典序比较；若一个组是另一个组的前缀，较短者更小。

## 结果

- `Result.Groups` 给出排序后的分组。`Group.Score` 是该组内部收益和。
- `Group.Basis` 给出组内每一记录对的收益、是否由 must-link 强制，以及一条最短 must-link 链。
- 无解时 `Result.Feasible == false`，`Result.Conflict` 给出 `cannot-link`、连接其端点的 must-link 路径，以及完整的约束链 `Chain`；同时返回可用 `errors.Is(err, dataeng.ErrUnsatisfiable)` 判断的错误。

## 验证

`cluster_test.go` 内置独立的参考实现，枚举全部集合分区，并与求解器逐例比较。测试覆盖负收益、全零并列、must-link 传递闭包、must-link/cannot-link 环、矛盾约束链和 12 条记录边界。

```sh
go test ./...
```
