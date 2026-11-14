# 扫描件页序裁决

可导入的 Go 组件，用于档案导入时根据多类证据重排扫描页：

- 显式页码 OCR 候选及其置信度；
- 双面扫描的正反面与页码奇偶；
- 原始文件/扫描顺序；
- 重复页内容摘要（同一物理页的多次扫描）。

结果按代价从低到高返回。存在同等或接近同等可信的解释时，组件会保留多个候选及各自的代价分解，不会强行给出唯一排列。

## 快速使用

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0074"
)

func main() {
	solver, err := dataeng.NewSolver(dataeng.Options{
		MaxCandidates: 5,
		CostWindow:    0.5,
		// 开启严格连续检查，并用 MissingPages 声明可接受的缺号。
		RequireContiguous: true,
	})
	if err != nil {
		panic(err)
	}

	result, err := solver.Solve(dataeng.Document{
		Pages: []dataeng.Page{
			{
				ID:        "scan-0001",
				FileIndex: 0,
				Side:      dataeng.SideFront,
				Candidates: []dataeng.NumberCandidate{
					{Number: 1, Confidence: 0.98},
				},
			},
			{
				ID:        "scan-0002",
				FileIndex: 1,
				Side:      dataeng.SideBack,
				Candidates: []dataeng.NumberCandidate{
					{Number: 2, Confidence: 0.91},
					{Number: 3, Confidence: 0.42},
				},
			},
			{
				ID:        "scan-0003",
				FileIndex: 2,
				Role:      dataeng.RoleCover,
			},
		},
		// 严格连续模式下，这些缺号不会产生连续性代价。
		MissingPages: []int{4, 5},
	})
	if err != nil {
		panic(err)
	}

	for rank, candidate := range result.Candidates {
		fmt.Printf("rank=%d cost=%.3f exhaustive=%v pages=%v\n",
			rank, candidate.Cost, result.Exhaustive, candidate.Order())
		fmt.Printf("breakdown=%+v\n", candidate.Breakdown)
	}
}
```

`Options{}` 可直接使用。若要只返回代价完全相同的候选，将 `CostWindow` 设为很小的正数，例如 `1e-9`。

## 语义

- 每个输入页在结果中恰好出现一次；摘要相同只会提示重复扫描，不会静默删除页面。
- 只有 `RoleContent` 页参与页码、奇偶和连续性约束。`RoleCover`、`RoleInsert` 以及没有选中页码的正文页对连续页码链是透明的。
- 默认允许页码跳号，因为档案批次可能缺页。`RequireContiguous=true` 时，两个相邻带号正文页之间未声明的缺号会产生连续性代价；`MissingPages` 中完整声明的缺号不计费。
- 双面扫描默认遵循 `FrontOddBackEven`。可使用 `FrontEvenBackOdd` 或 `ParityIgnored`。
- `FileIndex` 相同时按 `Document.Pages` 顺序稳定处理；所有 `FileIndex` 都为零时即使用切片顺序。
- 重复摘要只在组内存在共识候选时增强/惩罚候选一致性，避免在所有重复页 OCR 完全冲突时诱导“全部放弃页码”。

## 代价项

| 字段 | 含义 | 默认权重 |
| --- | --- | ---: |
| `OCR` | 选中候选的 `1-confidence` | 1.0 |
| `PageNumber` | 相邻带号正文页页码回退或重复 | 4.0 |
| `Continuity` | 严格模式下未声明的缺号 | 1.5 |
| `Parity` | 页码奇偶与正反面矛盾 | 2.0 |
| `FileOrder` | 相对文件顺序的成对逆序数 | 0.75 |
| `Duplicate` | 重复摘要组内未获共识支持的页码读法 | 2.0 |
| `Unnumbered` | 正文页放弃已有 OCR 候选 | 3.0 |

任一权重非零时，`Weights` 按原样使用；因此可显式把不关心的项设为 0。全部为零时采用默认权重。

## 精确解与大批量

- `Solve`：小批量自动使用精确子集 DP，大批量自动切换束搜索。用 `Result.Exhaustive` 判断首个候选是否有全局最优保证。
- `SolveExact`：穷举所有页面顺序与 OCR 候选组合的状态空间。首个候选可证明为全局最优；批量或状态数超过内部预算时返回 `ErrTooManyPages`。
- `SolveBeam`：强制使用有界束搜索，`BeamWidth` 控制保留前缀数，适合大扫描批次。

精确求解器使用 Held-Karp 子集 DP：状态只记录“已放置页集合 + 最近一个带号正文页及其候选”，因此不会随普通页面数量产生阶乘级枚举。

## 验证

```bash
go test ./...
go test ./... -race
go vet ./...
```

测试包含随机小批次的“精确 DP vs 暴力枚举”最优代价对照、冲突多候选、缺页/插页/封面豁免、重复摘要和求解器确定性。
