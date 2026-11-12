package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0304"
)

func ExampleMerge() {
	inputs := []dataeng.Histogram{
		{
			Scale:     0,
			Positive:  dataeng.Group{Offset: 0, Counts: []uint64{1, 2}},
			Threshold: dataeng.NewZeroThreshold(),
			Count:     3,
		},
		{
			Scale:     1,
			Positive:  dataeng.Group{Offset: 0, Counts: []uint64{4, 0, 6}},
			Threshold: dataeng.NewZeroThreshold(),
			Count:     10,
		},
	}

	merged, err := dataeng.Merge(inputs, 4096)
	if err != nil {
		panic(err)
	}
	fmt.Printf("scale=%d threshold=0 count=%d positive=%v\n",
		merged.Scale, merged.Count, merged.Positive.Counts)

	// Output:
	// scale=0 threshold=0 count=13 positive=[5 8]
}
