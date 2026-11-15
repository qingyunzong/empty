package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0175"
)

func ExampleDetector() {
	detector, err := dataeng.New(dataeng.Config{
		DeleteAfter:      2,
		MaxRecheckCycles: 1,
	})
	if err != nil {
		panic(err)
	}

	detector.ObserveComplete([]dataeng.ID{"a", "b"})
	detector.ObserveComplete(nil)           // first complete-generation miss
	events := detector.ObserveComplete(nil) // second miss: delete

	for _, event := range events {
		fmt.Printf("%s %s version=%d\n", event.Kind, event.ID, event.Version)
	}

	// Output:
	// deleted a version=2
	// deleted b version=2
}
