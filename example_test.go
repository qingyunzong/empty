package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0101"
)

func ExampleOperator() {
	op, _ := dataeng.NewTumbling(10, 5)

	_, _, _ = op.Process(dataeng.Event{Partition: "p", Key: "k", Timestamp: 1})

	results, _ := op.AdvanceWatermark("p", "source", 10)
	for _, result := range results {
		fmt.Printf("window=%v version=%d late=%v\n", result.Window, result.Version, result.Late)
	}

	results, _, _ = op.Process(dataeng.Event{Partition: "p", Key: "k", Timestamp: 5})
	for _, result := range results {
		fmt.Printf("window=%v version=%d late=%v\n", result.Window, result.Version, result.Late)
	}

	_, _ = op.AdvanceWatermark("p", "source", 15)
	_, sides, _ := op.Process(dataeng.Event{Partition: "p", Key: "k", Timestamp: 8})
	for _, side := range sides {
		fmt.Printf("side=%s window=%v\n", side.Reason, side.Windows)
	}

	// Output:
	// window=[0,10) version=1 late=false
	// window=[0,10) version=2 late=true
	// side=after_deadline window=[[0,10)]
}
