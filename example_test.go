package dataeng_test

import (
	"errors"
	"fmt"

	dataeng "example.org/dataeng/q0073"
)

func ptrInt64(v int64) *int64 { return &v }

func Example() {
	db := dataeng.New()

	// 批次插入：同值不同 ID 分别计数，nil 表示空值记录。
	snap, err := db.Apply([]dataeng.Op{
		{Kind: dataeng.OpInsert, Group: "orders", Record: dataeng.Record{ID: "r1", Value: ptrInt64(10)}},
		{Kind: dataeng.OpInsert, Group: "orders", Record: dataeng.Record{ID: "r2", Value: ptrInt64(20)}},
		{Kind: dataeng.OpInsert, Group: "orders", Record: dataeng.Record{ID: "r3", Value: nil}},
	})
	if err != nil {
		panic(err)
	}

	stats, _ := snap.Stats("orders")
	fmt.Println("v2 count:", stats.Count, "nonNull:", stats.NonNull, "sum:", stats.Sum, "avg:", stats.Avg)

	// 非法删除导致整批回滚，DB 仍停留在上一版本。
	_, err = db.Apply([]dataeng.Op{
		{Kind: dataeng.OpDelete, Group: "orders", Record: dataeng.Record{ID: "ghost"}},
	})
	fmt.Println("rollback:", errors.Is(err, dataeng.ErrIDMissing), "version:", db.Version())

	// 替换为空值并删除其余记录；空组从结果移除，旧快照仍可被读者保留。
	newSnap, err := db.Apply([]dataeng.Op{
		{Kind: dataeng.OpReplace, Group: "orders", Record: dataeng.Record{ID: "r1", Value: nil}},
		{Kind: dataeng.OpDelete, Group: "orders", Record: dataeng.Record{ID: "r2"}},
	})
	if err != nil {
		panic(err)
	}
	allNull, _ := newSnap.Stats("orders")
	fmt.Println("all-null sum is nil:", allNull.Sum == nil, "count:", allNull.Count)

	_, err = db.Apply([]dataeng.Op{
		{Kind: dataeng.OpDelete, Group: "orders", Record: dataeng.Record{ID: "r1"}},
		{Kind: dataeng.OpDelete, Group: "orders", Record: dataeng.Record{ID: "r3"}},
	})
	if err != nil {
		panic(err)
	}
	_, exists := db.Latest().Stats("orders")
	fmt.Println("empty group removed:", !exists)

	// Output:
	// v2 count: 3 nonNull: 2 sum: 30 avg: 15/1
	// rollback: true version: 1
	// all-null sum is nil: true count: 2
	// empty group removed: true
}
