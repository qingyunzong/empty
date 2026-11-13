package dataeng_test

import (
	"fmt"

	"example.org/dataeng13/q0010"
)

func ExampleLedger() {
	l := dataeng.NewLedger()
	_, _ = l.AddSegment(dataeng.Segment{
		Start: 0, End: 4, Data: []byte("abcd"), Source: "head",
	})
	_, _ = l.AddSuffix(dataeng.Suffix{
		Length: 2, Data: []byte("yz"), Source: "tail",
	})
	_ = l.SetTotalSize(6)

	snap := l.Snapshot()
	fmt.Printf("ranges: %d, first: [%d,%d) %q %v\n",
		len(snap.Ranges), snap.Ranges[0].Start, snap.Ranges[0].End,
		snap.Ranges[0].Data, snap.Ranges[0].Sources)
	fmt.Printf("holes: %d, complete: %t\n", len(snap.Holes), snap.Complete)

	// Output:
	// ranges: 1, first: [0,6) "abcdyz" [head tail]
	// holes: 0, complete: true
}
