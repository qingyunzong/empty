package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0267"
)

func ExampleHost() {
	host, err := dataeng.NewHost(2)
	if err != nil {
		panic(err)
	}

	_, _ = host.UpdateInt(0, "clicks", dataeng.Time{X: 0, Y: 1}, 3)
	_, _ = host.UpdateInt(0, "clicks", dataeng.Time{X: 1, Y: 1}, 2)
	_, _ = host.UpdateInt(1, "views", dataeng.Time{X: 0, Y: 2}, 7)

	_, _ = host.RegisterQuery("batch-1", dataeng.Time{X: 1, Y: 1})
	status, _ := host.QueryStatus("batch-1")
	fmt.Printf("pending: query=%s", status.Query)
	for _, blocker := range status.Blockers {
		fmt.Printf(" input%d=%v", blocker.Input, blocker.Points)
	}
	fmt.Println()

	out, _ := host.AdvanceFrontier(0, []dataeng.Time{{X: 2, Y: 0}, {X: 0, Y: 2}})
	fmt.Println("delivered after input 0:", len(out.Delivered))

	out, _ = host.AdvanceFrontier(1, []dataeng.Time{{X: 2, Y: 0}, {X: 0, Y: 2}})
	fmt.Println("delivered:", out.Delivered[0].ID)
	fmt.Println("clicks:", out.Delivered[0].Weights["clicks"].String())

	// Output:
	// pending: query=(1,1) input0=[(0,0)] input1=[(0,0)]
	// delivered after input 0: 0
	// delivered: batch-1
	// clicks: 5
}
