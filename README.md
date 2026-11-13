# Range partition 采样边界

排序作业需要可导入的 Go range partition 边界规划器，从各分片带权样本和总行数估计 P 个连续区间。重复重键可形成专属区间但边界仍全序；目标最小化最大负载估计并给稳定并列规则。小域可枚举边界核对最优性。

## 用法

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0162"
)

func main() {
	shards := []dataeng.Shard[string]{
		{Name: "shard-0", Samples: []dataeng.Sample[string]{
			{Key: "apple", Weight: 12},
			{Key: "hot", Weight: 240},
			{Key: "zebra", Weight: 8},
		}},
		{Name: "shard-1", Samples: []dataeng.Sample[string]{
			{Key: "banana", Weight: 30},
			{Key: "hot", Weight: 160},
			{Key: "zebra", Weight: 4},
		}},
	}

	plan, err := dataeng.Plan(shards, 1_000_000, 4)
	if err != nil {
		panic(err)
	}

	fmt.Println("boundaries:", plan.Boundaries)
	fmt.Println("max load:", plan.MaxLoad)
	for _, partition := range plan.Partitions {
		fmt.Printf("%d: %v..%v load=%v keys=%d empty=%v\n",
			partition.Index, partition.Lower, partition.Upper,
			partition.Load, partition.Keys, partition.Empty)
	}
}
```

`Plan` 接收多个分片的带权样本；`PlanSamples` 接收单个扁平样本列表。所有分片的样本按
key 聚合，重复 key 的全部权重始终落在同一个区间。聚合权重再按 `totalRows` 做统一缩放，
因此权重可以是计数，也可以是逆采样概率权重，只有相对大小影响边界。

## 边界约定

- `Boundaries` 长度为 `P-1`，元素是闭区间上界。分片器应将 key `k` 放入第一个满足
  `k <= Boundaries[i]` 的区间；超过所有边界时放入最后一个区间。
- 边界按 key 升序且非递减；两个相邻非空区间之间的边界严格递增。
- 当不同 key 数量少于 `P` 时，每个 key 独占一个区间，其余区间为空且排在最后，
  对应边界重复最后一个 key。
- 某个 key 的所有重复样本不会被拆开，因此超重 key 可以自然形成专属区间。

## 最优性与并列规则

规划器最小化最大估计区间负载。所有达到同一最优最大负载的方案中，选择上界序列
字典序最小的方案；该规则只依赖 key 顺序，与输入样本、分片顺序无关。

不同 key 数量不超过 64 且边界组合数不超过 1,000,000 时，规划器直接枚举全部边界，
得到可核对的最优解。更大输入使用二分容量 + 线性重建，复杂度约为
`O(S + K log K + K log(total/maxKeyWeight))`，其中 `S` 是样本数、`K` 是不同 key 数。
`PlanExhaustive` 可对小域强制枚举，用于测试和对照；候选边界组合超过一千万时返回
`ErrExhaustiveTooLarge`。

## 校验

`Plan` 会拒绝非正分区数、负总行数、负/NaN/Inf 权重以及 NaN key。总行数为正但没有
正权重样本时返回 `ErrNoSamples`；总行数为零且无样本时返回 P 个空区间；总行数为零但
有样本时仍按样本分布给出边界，所有估计负载为零。
