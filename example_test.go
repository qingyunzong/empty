package formal_test

import (
	"context"
	"fmt"
	"time"

	formal "example.org/dlks/formal/q10162"
)

func ExampleClient_Acquire() {
	clock := formal.NewFakeClock()
	coordinator := formal.NewCoordinator(clock)
	defer coordinator.Close()

	client, err := formal.NewClient(coordinator, time.Minute)
	if err != nil {
		panic(err)
	}
	defer client.Close()

	handle, err := client.Acquire(context.Background(), "orders/42")
	if err != nil {
		panic(err)
	}

	var fencer formal.Fencer
	fmt.Println(fencer.Allow(handle.Token()))
	fmt.Println(fencer.Allow(handle.Token()))
	fmt.Println(handle.Unlock())

	// Output:
	// true
	// false
	// <nil>
}
