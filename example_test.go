package formal_test

import (
	"fmt"

	formal "example.org/dlks/formal/q10033"
)

func ExampleCalculator() {
	calc, err := formal.NewCalculator(formal.Config{Nodes: []formal.Node{
		{ID: "root", Limit: formal.Resources{"cpu": 3}},
		{ID: "team-a", Parent: "root", Priority: 2},
		{ID: "team-b", Parent: "root", Priority: 1},
	}})
	if err != nil {
		panic(err)
	}

	shares, err := calc.FairShareFresh([]formal.Demand{
		{Node: "team-a", Resources: formal.Resources{"cpu": 1}},
		{Node: "team-b", Resources: formal.Resources{"cpu": 2}},
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(shares["team-a"]["cpu"], shares["team-b"]["cpu"], shares["root"]["cpu"])

	hold, err := calc.Reserve(formal.Request{
		ID:        "job",
		Node:      "team-a",
		Resources: formal.Resources{"cpu": 1},
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(hold.Granted["cpu"], hold.State)

	if _, err := calc.Commit(hold.ID); err != nil {
		panic(err)
	}
	if _, err := calc.Release(hold.ID); err != nil {
		panic(err)
	}
	fmt.Println(len(calc.Holds()))

	// Output:
	// 1 2 3
	// 1 reserved
	// 0
}
