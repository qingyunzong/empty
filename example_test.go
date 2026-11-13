package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0133"
)

func ExampleMerge() {
	shardA := dataeng.NewReservoir(2)
	shardB := dataeng.NewReservoir(2)

	_ = shardA.Add("a", 1)
	_ = shardA.Add("b", 4)
	_ = shardB.Add("c", 3)
	_ = shardB.Add("d", 2)

	merged, err := dataeng.Merge(shardA, shardB)
	if err != nil {
		panic(err)
	}
	for _, rec := range merged.TopK() {
		fmt.Println(rec.ID)
	}
}
