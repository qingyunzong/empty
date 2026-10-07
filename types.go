// Package location solves the capacitated facility location problem (CFLP):
// choose a subset of candidate sites to open and assign each demand
// (unsplittable, integer size) to exactly one open site within a coverage
// distance limit, minimizing opening cost plus assignment distance cost.
package location

import "math"

// Site is a candidate facility with integer capacity.
type Site struct {
	ID       int
	X, Y     float64
	OpenCost float64
	Capacity int
}

// Demand is an unsplittable demand point with integer size.
type Demand struct {
	ID   int
	X, Y float64
	Size int
}

// Instance is a full problem instance. MaxDist is the coverage distance
// limit: a demand may only be assigned to a site within MaxDist.
// Budget > 0 enables budget-bound reporting on the solution.
type Instance struct {
	Sites   []Site
	Demands []Demand
	MaxDist float64
	Budget  float64
}

// Solution is the optimal open set plus assignment, together with the
// capacity certificate data (loads) and the budget bound.
type Solution struct {
	Open         []bool  // Open[i]: site i is opened
	Assign       []int   // Assign[j]: site index serving demand j
	Load         []int   // Load[i]: total demand size assigned to site i
	OpenCost     float64 // sum of opening costs
	AssignCost   float64 // sum of assignment distances
	TotalCost    float64 // OpenCost + AssignCost
	LowerBound   float64 // certified lower bound on the optimum
	HasBudget    bool    // instance carried a finite budget
	WithinBudget bool    // TotalCost <= Budget (only meaningful if HasBudget)
}

func dist(ax, ay, bx, by float64) float64 {
	return math.Hypot(ax-bx, ay-by)
}
