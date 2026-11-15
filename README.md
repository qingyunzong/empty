# dataeng：分组时间切分

可导入的 Go 库，用于构建防泄漏的 `train` / `validation` / `test` 切分。

## 硬约束

- **实体与关联组不可拆分**：记录中的 `Entity`、`Group`、`Groups` 构成一个无向图。每个连通分量是一个不可分割的 `GroupBlock`，只能进入一个 split。共享实体、共享组、以及通过任意实体/组链路传递相连的记录都会进入同一个块。
- **测试集严格晚于训练集**：所有 `Test` 记录的时间必须严格晚于所有 `Train` 记录。组内时间跨度按块的 `Latest` / `Earliest` 检查。若所有记录时间都是零值，则时间约束自动关闭。
- **默认三个 split 均非空**：可通过 `Config.AllowEmptySplits` 放宽。

## 目标

目标按 **整个语料的 (split, class) 质量占比** 表示：

```
target[train]["a"] + target[train]["b"] + ... +
target[validation]["a"] + ... + target[test]["a"] + ... = 1
```

目标矩阵会被归一化，因此也可以传入相对权重。类别质量使用 `Record.Weight`
（零值视为 1），所以重采样、样本权重和类别不平衡都能直接表达。

如果目标以“每个 split 内部的类别比例”给出，设置
`Config.TargetMode = TargetConditional`，并用 `SplitShares` 指定 split 大小；
库会将其转换为同一套质量目标。

默认最小化 L1 偏差：

```
sum over split, class of |achieved_share - target_share|
```

也支持 `L2`（平方和）与 `Linf`（最大单格偏差）。

## 快速开始

```go
package main

import (
	"fmt"
	"time"

	"example.org/dataeng/q0200"
)

func main() {
	target, _ := dataeng.BuildTarget(
		map[dataeng.SplitName]float64{
			dataeng.Train:      0.8,
			dataeng.Validation: 0.1,
			dataeng.Test:       0.1,
		},
		map[string]float64{"click": 0.7, "skip": 0.3},
	)

	records := []dataeng.Record{
		{ID: "r1", Entity: "user-1", Groups: []string{"session-9"}, Class: "click", Time: time.Unix(100, 0)},
		{ID: "r2", Entity: "user-2", Groups: []string{"session-9"}, Class: "skip", Time: time.Unix(110, 0)},
		{ID: "r3", Entity: "user-3", Groups: []string{"session-10"}, Class: "click", Time: time.Unix(200, 0)},
		{ID: "r4", Entity: "user-4", Groups: []string{"session-11"}, Class: "skip", Time: time.Unix(300, 0)},
	}

	result, err := dataeng.Split(records, dataeng.Config{
		Target:   target,
		MaxNodes: 100000,
	})
	if err != nil {
		panic(err)
	}

	fmt.Println(result.Status)      // optimal / budget_exhausted / infeasible
	fmt.Println(result.Objective)   // 0 表示目标完全命中
	fmt.Println(result.Assignments) // record ID -> split
	fmt.Println(result.Proof.Open)  // 预算耗尽时未闭合的子问题
}
```

如果只需要“每个 split 保持总体类别分布”，可以直接使用：

```go
cfg := dataeng.Config{
	SplitShares: map[dataeng.SplitName]float64{
		dataeng.Train: 0.8, dataeng.Validation: 0.1, dataeng.Test: 0.1,
	},
	ClassShares: map[string]float64{"click": 0.7, "skip": 0.3},
}
```

未提供 `ClassShares` 时使用语料的经验类别分布。

## 结果与证明

`Result` 同时包含：

- `Assignments`：记录 ID 到 split。
- `Blocks`：实际参与优化的不可分割块，以及每块的 split。
- `Counts` / `Proportions` / `Targets`：便于审计的加权统计与目标。
- `TimeBounds`：每个 split 的时间范围。
- `Objective`、`UpperBound`、`LowerBound`、`Gap`。
- `Proof`：搜索是否闭合，以及预算耗尽时仍未探索的 frontier。

`StatusOptimal` 表示下界已闭合，返回方案在硬约束下达到最低偏差，并按稳定块键 +
`train < validation < test` 的字典序完成并列决策。

`StatusBudgetExhausted` 表示预算耗尽：

- `Feasible == true` 时，`Objective == UpperBound` 是当前最佳可行解；
- `LowerBound` 是所有未闭合子问题下界的最小值；
- `Proof.Open` 给出确定性截取的 frontier（最多 32 条），`Proof.OpenCount`
  给出完整未闭合数量；
- `Gap = UpperBound - LowerBound`，可直接用于判断是否值得增加预算。

若没有任何可行解且搜索已闭合，返回 `StatusInfeasible`。

## 精确性与预算

优化器使用深度优先分支定界：

- 每个节点维护当前各 `(split, class)` 质量；
- 下界由“剩余类别质量可自由分配到各 split”的松弛给出，同时取按类别和按
  split 总量两个下界的最大值；该界对 L1/L2/Linf 都是可采纳的；
- 时间约束在增量分配时即时检查；
- 初始可行解由多个时间序/键序切点、贪心构造和局部搜索（移动与交换）产生；
- 预算耗尽时，递归栈上的所有未处理分支就是未闭合证明的 frontier。

默认节点预算为 `1000000`。`MaxNodes` / `MaxSteps` 可设置节点预算，
`MaxDuration` 可设置墙钟预算；`Unlimited` 关闭节点预算。小规模实例会精确求解，
大规模实例建议设置节点或时延预算并检查 `Status` / `Gap`。

## 验证

`Verify(records, cfg, result)` 会独立重新构图并检查：

- 每条记录恰好分配一次；
- 没有任何实体/组连通块跨 split；
- `test` 时间严格晚于 `train`；
- split 非空约束；
- `Counts`、`Proportions`、`Objective` 与方案一致。

## 确定性

- 块按稳定键排序：优先最小 `Group` ID，其次最小 `Entity` ID，最后记录 ID；
- 同一块内记录按 ID 排序；
- split 顺序固定为 `train`、`validation`、`test`；
- 目标值相同时选择字典序最小的块分配向量。

因此相同输入、相同配置会得到相同方案；节点预算耗尽时也会返回相同的 incumbent
与 frontier。

## 测试

```bash
go test ./...
go test -race ./...
go vet ./...
```

测试包含与 `3^blocks` 暴力枚举的逐项对比（L1/L2/Linf）、传递组闭包、实体/组
联系、严格时间约束、稳定并列决策、预算耗尽证明和独立验证。
