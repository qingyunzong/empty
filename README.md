# formal

`formal` 是一个供 FinOps 账单管道调用的 Go 分摊库。它把直接成本、共享成本和节省金额分摊到实体，并输出可逐笔审计的报告。

## 核心保证

- **金额精确**：`Money` 是以微单位（`1e-6`）存储的 `int64`，全程不使用浮点数。
- **共享成本可审计**：每条共享费用都必须给出显式 `Shares` 或 `Weights`；不会把没有权重依据的成本平均撒给所有实体。
- **严格守恒**：按整数权重使用最大余数法分配，每条费用的分摊之和精确等于该费用的有效金额，报告净额精确等于全部费用净额。
- **确定性**：余数按“余数降序、实体 ID 升序”分配，结果不依赖 map 顺序或输入 share 顺序。
- **标签继承**：实体标签沿 `Resource.Parent` 向上继承；空字符串视为缺失，不会遮蔽父级值。
- **缺失不猜测**：找不到实体标签时，成本进入受控的未分配实体（默认 `unallocated`），不会推断成其他团队。
- **节省可分摊**：`KindSaving` 表示正数节省金额，按权重分摊或直接归属资源；报告中的 `Savings` 为正数，净成本为其扣减后的值。
- **快照式重算**：`Allocate` 每次基于当前标签和费用生成全新报告，不累加、不修改旧报告；标签更新与分摊交错调用不会重复计费。

## 快速开始

```go
package main

import (
	"fmt"

	"example.org/dlks/formal/q10097"
)

func main() {
	allocator := formal.NewAllocator(formal.Options{EntityTag: "team"})

	_ = allocator.AddResource(formal.Resource{
		ID: "root", Tags: formal.Tags{"team": "platform"},
	})
	_ = allocator.AddResource(formal.Resource{ID: "web", Parent: "root", Tags: formal.Tags{"team": "web"}})
	_ = allocator.AddResource(formal.Resource{ID: "db", Parent: "root", Tags: formal.Tags{"team": "db"}})
	_ = allocator.AddResource(formal.Resource{ID: "batch", Parent: "root"})

	_ = allocator.AddCharge(formal.DirectCharge("web-vm", "web", formal.MustParseMoney("40.00")))
	_ = allocator.AddCharge(formal.DirectCharge("db-vm", "db", formal.MustParseMoney("20.00")))
	_ = allocator.AddCharge(formal.DirectCharge("batch-job", "batch", formal.MustParseMoney("5.00")))

	_ = allocator.AddCharge(formal.Charge{
		ID: "shared-nat", Amount: formal.MustParseMoney("12.00"), Kind: formal.KindShared,
		Shares: []formal.Share{
			formal.ResourceShare("web", 1),
			formal.ResourceShare("db", 1),
		},
	})
	_ = allocator.AddCharge(formal.SavingCharge(
		"commitment-saving",
		"root",
		formal.MustParseMoney("3.00"),
		map[string]int64{"web": 2, "db": 1},
	))

	report, err := allocator.Allocate()
	if err != nil {
		panic(err)
	}
	if err := report.Check(); err != nil {
		panic(err)
	}

	for _, entity := range report.Entities {
		fmt.Printf("%s: %s (direct=%s shared=%s savings=%s)\n",
			entity.Entity, entity.Total, entity.Direct, entity.Shared, entity.Savings)
	}
	fmt.Println("net:", report.GrandTotal(), "unallocated:", report.Totals.Unallocated)
}
```

## 数据模型

- `Resource{ID, Parent, Tags}` 构成资源森林。
- `Charge{ID, ResourceID, Amount, Kind, TagKey, Shares, Weights}` 是一条账单费用。
- `KindDirect`：整笔费用归属资源通过继承得到的实体标签。
- `KindShared`：按 `Shares`/`Weights` 的公开整数权重拆分。
- `KindSaving`：正数节省金额；无权重时直接归属资源，有权重时按权重拆成负成本。
- `Share{Entity, ResourceID, Weight}`：`Entity` 直接指定接收实体；`ResourceID` 先解析该资源的继承标签。二者都为空时权重进入未分配项；同时设置会被拒绝。
- `Weights map[string]int64` 是 `Shares` 的便捷形式，键为实体 ID。

`Options.EntityTag` 选择实体标签键，默认 `entity`。`Options.UnallocatedEntity` 选择未分配桶，默认 `unallocated`；该名称在报告中保留给缺失标签，不应作为真实实体名。单条费用可用 `Charge.TagKey` 覆盖全局标签键。

## 分摊语义

1. 加载资源并检查重复 ID、未知父节点和层级环。
2. 对每条费用解析实体；`ResourceID` 必须存在。
3. 直接费用整笔记入实体；共享费用按聚合后的权重拆分；节省费用转换为负成本。
4. 缺失标签或空 share 目标记入未分配桶。
5. 每条费用按最大余数法补足整数微单位，因此逐条守恒且总量守恒。
6. `Report.Check` 验证实体合计、费用合计、权重合计及未分配标记的一致性。

`Report.Entities` 仅包含至少收到过一笔非零分摊的实体；若这些分摊正好相互抵消，实体仍会保留，合计为 0。

共享费用缺少任何权重、权重为负、权重总和为零、资源引用不存在、层级有环等输入都会返回错误，而不是静默猜测。

## 快照与交错更新

`Allocator` 的 `Add*`、`SetTag`、`UpdateTags`、`DeleteTag` 会推进 `Revision`；`Allocate` 不修改状态，也不改变已有 `Report`。因此管道可以安全地执行：

```go
before, _ := allocator.Allocate()
_ = allocator.SetTag("web", "team", "growth")
after, _ := allocator.Allocate()
```

`before` 保留旧标签下的结果，`after` 是最新标签下的完整重算结果；两次报告不会相加。`Allocator` 本身并发安全。

## 测试

```sh
go test ./...
go test -race ./...
```

测试包含 23,040 组小账单组合，逐笔使用独立的朴素实现重算，对比每条费用的有效金额、权重和实体分摊，并校验每个实体合计、未分配桶及总账守恒。另有标签更新与分摊交错、重复分摊幂等、并发访问和输入校验测试。
