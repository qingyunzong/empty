package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0117"
)

func ExampleCluster() {
	result, err := dataeng.Cluster(
		[]dataeng.Pair{{Left: "a", Right: "b"}},
		[]dataeng.Pair{{Left: "b", Right: "c"}},
		[]dataeng.Candidate{
			{Left: "a", Right: "c", Score: 0.9},
			{Left: "c", Right: "d", Score: 0.8},
		},
	)
	if err != nil {
		panic(err)
	}

	fmt.Println(result.Clusters)
	fmt.Println(result.Decisions[0].Accepted)
	fmt.Println(result.Rejected[0].Path)
	fmt.Println(result.Rejected[0].Path.Length())
	// Output:
	// [[a b] [c d]]
	// false
	// a -must-link-> b -cannot-link-> c
	// 2
}
