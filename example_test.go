package formal

import (
	"fmt"
)

func ExampleAggregator() {
	a := New()

	a.Apply(HealthEvent("api-1", 1, 1, HealthHealthy))
	a.Apply(WeightEvent("api-1", 1, 1, 3))

	a.Apply(HealthEvent("api-2", 1, 1, HealthHealthy))
	a.Apply(WeightEvent("api-2", 1, 1, 1))
	a.Apply(DrainEvent("api-2", 1, 2, DrainDraining))

	for _, instance := range a.Available() {
		fmt.Printf("%s weight=%d\n", instance.ID, instance.Weight)
	}

	id, ok := a.Select(0)
	fmt.Printf("select=%s ok=%v\n", id, ok)

	// Output:
	// api-1 weight=3
	// select=api-1 ok=true
}

func ExampleAggregator_reconnect() {
	a := New()

	a.Apply(HealthEvent("api-1", 1, 1, HealthHealthy))
	a.Apply(DrainEvent("api-1", 1, 2, DrainDrained))

	// A late report from the drained connection cannot bring the instance back.
	a.Apply(HealthEvent("api-1", 1, 3, HealthHealthy))
	fmt.Println("after stale report:", a.Len())

	// A new connection generation is a new incarnation and starts with fresh
	// defaults until new observations arrive.
	a.Apply(HealthEvent("api-1", 2, 1, HealthHealthy))
	instance, ok := a.Lookup("api-1")
	fmt.Printf("generation=%d weight=%d ok=%v\n", instance.Generation, instance.Weight, ok)

	// Output:
	// after stale report: 0
	// generation=2 weight=1 ok=true
}
