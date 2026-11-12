package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0188"
)

// Example 演示时间外键的批增删、缺口查询与删除影响报告。
func Example() {
	c := dataeng.New[string, string, string]()

	_ = c.AddParents([]dataeng.ParentRecord[string, string]{
		{RecordID: "p1", Key: "acct", Valid: dataeng.Interval{Start: 0, End: 10}},
		{RecordID: "p2", Key: "acct", Valid: dataeng.Interval{Start: 10, End: 20}},
	})
	_ = c.AddChildren([]dataeng.ChildRecord[string, string]{
		{RecordID: "c1", Ref: strptr("acct"), Valid: dataeng.Interval{Start: 0, End: 25}},
	})

	gaps, _ := c.Gaps("c1")
	fmt.Println("gaps before:", gaps)

	report, err := c.DeleteParents([]string{"p2"})
	if err != nil {
		fmt.Println("delete error:", err)
		return
	}
	for _, chg := range report.Affected {
		fmt.Println("affected:", chg.ChildID, "before:", chg.Before,
			"after:", chg.After, "net:", chg.NetNew)
	}
	gaps, _ = c.Gaps("c1")
	fmt.Println("gaps after:", gaps)
	fmt.Println("verify:", c.Verify())

	// Output:
	// gaps before: [{20 25}]
	// affected: c1 before: [{20 25}] after: [{10 25}] net: [{10 20}]
	// gaps after: [{10 25}]
	// verify: <nil>
}

func strptr(s string) *string { return &s }
