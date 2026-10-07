// Command flp solves a small demo instance and prints its capacity
// certificate and budget bound.
package main

import (
	"fmt"
	"log"

	"location"
)

func main() {
	inst := location.Instance{
		Sites: []location.Site{
			{ID: 0, X: 0, Y: 0, OpenCost: 10, Capacity: 3},
			{ID: 1, X: 10, Y: 0, OpenCost: 12, Capacity: 3},
			{ID: 2, X: 5, Y: 8, OpenCost: 8, Capacity: 4},
		},
		Demands: []location.Demand{
			{ID: 0, X: 1, Y: 1, Size: 2},
			{ID: 1, X: 9, Y: 1, Size: 2},
			{ID: 2, X: 5, Y: 7, Size: 2},
			{ID: 3, X: 4, Y: 6, Size: 2},
		},
		MaxDist: 12,
		Budget:  40,
	}
	sol, err := location.Solve(inst)
	if err != nil {
		log.Fatal(err)
	}
	if err := location.Verify(inst, sol); err != nil {
		log.Fatalf("certificate invalid: %v", err)
	}
	fmt.Print(location.Report(inst, sol))
}
