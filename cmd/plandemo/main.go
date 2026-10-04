// Command plandemo prints the per-step cache states of an optimal plan
// for a sample dependency DAG.
package main

import (
	"fmt"

	"cacheplan/cacheplan"
)

func main() {
	g := &cacheplan.Graph{Nodes: []cacheplan.Node{
		{Name: "core", Cost: 10, Size: 4},
		{Name: "libA", Cost: 6, Size: 3, Deps: []int{0}},
		{Name: "libB", Cost: 5, Size: 3, Deps: []int{0}},
		{Name: "app", Cost: 2, Size: 1, Deps: []int{1, 2}},
	}}
	demands := []int{3, 3, 1, 2, 3} // app, app, libA, libB, app
	p, err := cacheplan.Optimize(g, demands, 7)
	if err != nil {
		panic(err)
	}
	fmt.Print(p.String(g))
}
