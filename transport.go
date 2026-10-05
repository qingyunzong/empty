// Package transport solves a fixed-assignment transportation planning
// problem that must remain feasible under two public capacity scenarios.
//
// A plan assigns every order to exactly one line (orders are indivisible).
// The plan is feasible only if it satisfies line capacities, shared
// temperature-zone capacities, delivery time windows and predecessor
// delivery constraints in BOTH scenarios simultaneously. The cost of a
// plan is the larger of the two scenario costs, and the solver minimizes
// that value (minimax).
package transport

import "errors"

// Limits on the public problem size.
const (
	MaxOrders = 8
	MaxLines  = 6
)

// ScenarioCount is the number of public capacity scenarios.
const ScenarioCount = 2

// Order is an indivisible delivery request.
type Order struct {
	ID   string
	Size float64
	// Zone is the temperature zone the order belongs to. Orders in the
	// same zone share the zone capacity pool across all lines.
	Zone string
	// Earliest and Latest form the delivery time window. The arrival
	// time (scenario dependent) must fall inside it in every scenario.
	Earliest float64
	Latest   float64
	// Predecessor is the index of an order that must be delivered no
	// later than this order (arrival(pred) <= arrival(this)) in every
	// scenario. -1 means no predecessor.
	Predecessor int
}

// Line is a transport line that can be activated at a fixed cost.
type Line struct {
	ID        string
	FixedCost float64
	// Capacity[s] is the line capacity under scenario s.
	Capacity [ScenarioCount]float64
}

// Problem is a fixed-assignment transportation planning instance.
type Problem struct {
	Orders []Order
	Lines  []Line
	// ZoneCapacity[z][s] is the shared capacity pool of temperature
	// zone z under scenario s, summed over all lines.
	ZoneCapacity map[string][ScenarioCount]float64
	// Travel[s][order][line] is the arrival time of the order when it
	// is served by the line under scenario s.
	Travel [ScenarioCount][][]float64
	// Cost[s][order][line] is the variable cost of serving the order
	// with the line under scenario s.
	Cost [ScenarioCount][][]float64
}

// Validate checks structural limits and data consistency.
func (p *Problem) Validate() error {
	if len(p.Orders) == 0 {
		return errors.New("transport: no orders")
	}
	if len(p.Orders) > MaxOrders {
		return errors.New("transport: too many orders (max 8)")
	}
	if len(p.Lines) == 0 {
		return errors.New("transport: no lines")
	}
	if len(p.Lines) > MaxLines {
		return errors.New("transport: too many lines (max 6)")
	}
	for i, o := range p.Orders {
		if o.ID == "" {
			return errors.New("transport: order with empty ID")
		}
		if o.Size < 0 {
			return errors.New("transport: negative order size")
		}
		if o.Earliest > o.Latest {
			return errors.New("transport: empty time window for order " + o.ID)
		}
		if o.Predecessor < -1 || o.Predecessor >= len(p.Orders) {
			return errors.New("transport: predecessor index out of range for order " + o.ID)
		}
		if o.Predecessor == i {
			return errors.New("transport: order " + o.ID + " is its own predecessor")
		}
	}
	for _, l := range p.Lines {
		if l.ID == "" {
			return errors.New("transport: line with empty ID")
		}
	}
	for s := 0; s < ScenarioCount; s++ {
		if len(p.Travel[s]) != len(p.Orders) || len(p.Cost[s]) != len(p.Orders) {
			return errors.New("transport: travel/cost dimension mismatch")
		}
		for i := range p.Orders {
			if len(p.Travel[s][i]) != len(p.Lines) || len(p.Cost[s][i]) != len(p.Lines) {
				return errors.New("transport: travel/cost dimension mismatch")
			}
		}
	}
	return nil
}
