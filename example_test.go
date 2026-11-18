package formal_test

import (
	"fmt"

	formal "example.org/dlks/formal/q10034"
)

func ExampleAllocator() {
	allocator := formal.NewAllocator()
	result, err := allocator.Allocate(
		[]formal.Zone{
			{Name: "zone-a", Capacity: 2},
			{Name: "zone-b", Capacity: 1},
		},
		[]formal.Endpoint{
			{ID: "pod-1", ZoneHint: "zone-a", Ready: true},
			{ID: "pod-2", ZoneHint: "zone-b", Ready: true},
			{ID: "pod-3", ZoneHint: "zone-a", Ready: true},
			{ID: "pod-4", ZoneHint: "zone-a", Terminating: true},
		},
	)
	if err != nil {
		fmt.Println(err)
		return
	}

	fmt.Printf("zone-a: total=%d weighted=%d\n", result.Counts["zone-a"], result.WeightedCounts["zone-a"])
	fmt.Printf("zone-b: total=%d weighted=%d\n", result.Counts["zone-b"], result.WeightedCounts["zone-b"])
	fmt.Printf("moved=%d\n", len(result.Moved))

	// Output:
	// zone-a: total=3 weighted=2
	// zone-b: total=1 weighted=1
	// moved=0
}
