package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0149"
)

// 演示一个行级两环：r1 与 r2 通过可空外键互相引用，
// 规划器只置 null 字节序最小的单元格，先装载被依赖行，再补写。
func ExampleBuildPlan_cycle() {
	r1 := dataeng.RowRef{TableID: "orders", RowID: "r1"}
	r2 := dataeng.RowRef{TableID: "orders", RowID: "r2"}
	rows := []dataeng.RowRef{r1, r2}
	refs := []dataeng.Reference{
		{
			Source:   r1,
			FieldID:  "parent_id",
			Target:   &r2,
			Nullable: true,
		},
		{
			Source:   r2,
			FieldID:  "root_id",
			Target:   &r1,
			Nullable: true,
		},
	}

	plan, err := dataeng.BuildPlan(rows, refs)
	if err != nil {
		fmt.Println("error:", err)
		return
	}

	fmt.Println("load order:")
	for _, row := range plan.LoadOrder {
		fmt.Printf("  %s/%s\n", row.TableID, row.RowID)
	}
	fmt.Println("deferred fields:")
	for _, d := range plan.DeferredFields {
		fmt.Printf("  %s/%s.%s -> null\n", d.Source.TableID, d.Source.RowID, d.FieldID)
	}
	fmt.Println("backfills:")
	for _, b := range plan.Backfills {
		fmt.Printf("  %s/%s.%s = %s/%s\n",
			b.Source.TableID, b.Source.RowID, b.FieldID, b.Target.TableID, b.Target.RowID)
	}
	// Output:
	// load order:
	//   orders/r1
	//   orders/r2
	// deferred fields:
	//   orders/r1.parent_id -> null
	// backfills:
	//   orders/r1.parent_id = orders/r2
}

// 演示非可空外键构成的环无法恢复：这类边不允许延迟。
func ExampleBuildPlan_nonDeferrableCycle() {
	r1 := dataeng.RowRef{TableID: "a", RowID: "1"}
	r2 := dataeng.RowRef{TableID: "a", RowID: "2"}
	refs := []dataeng.Reference{
		{Source: r1, FieldID: "fk", Target: &r2, Nullable: false},
		{Source: r2, FieldID: "fk", Target: &r1, Nullable: false},
	}
	_, err := dataeng.BuildPlan([]dataeng.RowRef{r1, r2}, refs)
	fmt.Println(err)
	// Output:
	// analyze: dataeng: non-deferrable foreign key cycle: cycle consists solely of non-nullable foreign keys
}
