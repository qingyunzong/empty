package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0094"
)

func ExampleBuild() {
	fields := []dataeng.Field{
		{
			Path:    []dataeng.Segment{dataeng.NameSegment("user"), dataeng.NameSegment("name")},
			Value:   "alice",
			Ordinal: 0,
		},
		{
			Path:    []dataeng.Segment{dataeng.NameSegment("user"), dataeng.NameSegment("name")},
			Value:   "alice",
			Ordinal: 3,
		},
		{
			Path: []dataeng.Segment{
				dataeng.NameSegment("user"),
				dataeng.NameSegment("tags"),
				dataeng.IndexSegment(2),
			},
			Value:   "third",
			Ordinal: 1,
		},
	}

	root, err := dataeng.Build(fields, dataeng.Limits{MaxArrayIndex: 16, MaxCells: 64})
	if err != nil {
		fmt.Println("rejected:", err)
		return
	}

	user := root.Fields[0].Node
	fmt.Println("name:", user.Fields[0].Node.Value, user.Fields[0].Node.Origins)
	tags := user.Fields[1].Node
	fmt.Println("tag[0] missing:", tags.Elems[0].IsMissing())
	fmt.Println("tag[2]:", tags.Elems[2].Value, tags.Elems[2].Origins)

	// Output:
	// name: alice [0 3]
	// tag[0] missing: true
	// tag[2]: third [1]
}
