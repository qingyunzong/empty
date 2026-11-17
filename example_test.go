package formal_test

import (
	"fmt"

	formal "example.org/dlks/formal/q10185"
)

// A team reclaims its guaranteed quota from a sibling that borrowed it;
// the victim is the borrowed job with the least completed work.
func ExamplePlan() {
	tree := &formal.Tree{Root: &formal.Node{
		Name: "root", Guarantee: 8,
		Children: []*formal.Node{
			{Name: "nlp", Guarantee: 4},
			{Name: "cv", Guarantee: 4},
		},
	}}
	in := formal.Input{
		Capacity: 8,
		Tree:     tree,
		Jobs: []formal.Job{
			{ID: "cv-old", Queue: "cv", Priority: 1, Members: 1, UnitsPerMember: 4,
				Running: true, Preemptible: true, CompletedWork: 900, Seq: 1},
			{ID: "cv-extra", Queue: "cv", Priority: 1, Members: 1, UnitsPerMember: 4,
				Running: true, Preemptible: true, CompletedWork: 3, Seq: 2},
			{ID: "nlp-new", Queue: "nlp", Priority: 1, Members: 1, UnitsPerMember: 4, Seq: 3},
		},
	}
	plan, err := formal.Plan(in, nil)
	if err != nil {
		panic(err)
	}
	for _, j := range plan.Start {
		fmt.Println("start:", j.ID)
	}
	for _, j := range plan.Preempt {
		fmt.Println("preempt:", j.ID)
	}
	// Output:
	// start: nlp-new
	// preempt: cv-extra
}
