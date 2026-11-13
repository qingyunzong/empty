package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0162"
)

func ExamplePlan() {
	shards := []dataeng.Shard[int]{
		{Name: "left", Samples: []dataeng.Sample[int]{
			{Key: 1, Weight: 10},
			{Key: 2, Weight: 20},
		}},
		{Name: "right", Samples: []dataeng.Sample[int]{
			{Key: 3, Weight: 30},
			{Key: 4, Weight: 40},
		}},
	}

	plan, err := dataeng.Plan(shards, 100, 3)
	if err != nil {
		panic(err)
	}
	fmt.Println("boundaries:", plan.Boundaries)
	fmt.Println("max load:", plan.MaxLoad)

	// Output:
	// boundaries: [2 3]
	// max load: 40
}
