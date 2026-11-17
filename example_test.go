package formal_test

import (
	"fmt"
	"time"

	formal "example.org/dlks/formal/q2538"
)

func ExamplePlanner_Step() {
	planner, err := formal.NewPlanner(formal.Policy{
		DesiredReplicas:  6,
		MaxSurge:         formal.Int(2),
		MaxUnavailable:   formal.Int(1),
		ReadinessDelay:   2 * time.Second,
		TerminationGrace: 3 * time.Second,
	})
	if err != nil {
		panic(err)
	}

	decision, err := planner.Step(formal.Observation{
		Now:      0,
		Capacity: formal.UnlimitedCapacity,
	})
	if err != nil {
		panic(err)
	}
	fmt.Printf("%s %d ready-by=%s\n",
		decision.Action.Kind, decision.Action.Replicas, decision.Action.ReadyAt)
	// Output:
	// scale-up 6 ready-by=2s
}
