// Command dagcache-demo plans caching for an example dependency DAG and
// prints the cache state after every demand step.
package main

import (
	"fmt"
	"os"

	"dagcache"
)

func main() {
	// Shared intermediate products: features feed models, models feed reports.
	g := &dagcache.Graph{Nodes: []dagcache.Node{
		{Name: "raw-etl", Cost: 8, Size: 3},
		{Name: "features-a", Cost: 5, Size: 2, Deps: []int{0}},
		{Name: "features-b", Cost: 6, Size: 2, Deps: []int{0}},
		{Name: "model-x", Cost: 9, Size: 1, Deps: []int{1}},
		{Name: "model-y", Cost: 7, Size: 1, Deps: []int{1, 2}},
		{Name: "report-p", Cost: 4, Size: 1, Deps: []int{3}},
		{Name: "report-q", Cost: 4, Size: 1, Deps: []int{4}},
	}}
	demands := []int{5, 6, 5, 6, 3, 4} // report-p, report-q, ...
	var budget int64 = 4

	plan, err := g.OptimalPlan(demands, budget)
	if err != nil {
		fmt.Fprintln(os.Stderr, "plan:", err)
		os.Exit(1)
	}
	fmt.Printf("budget=%d demands=%d\n", budget, len(demands))
	fmt.Print(g.FormatPlan(plan))

	ref, err := g.BruteForceCost(demands, budget)
	if err != nil {
		fmt.Fprintln(os.Stderr, "brute force:", err)
		os.Exit(1)
	}
	fmt.Printf("exhaustive-search reference: %d (match=%v)\n", ref, ref == plan.TotalCost)
}
