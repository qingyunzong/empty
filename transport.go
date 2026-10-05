// Package transport implements a fixed-assignment transportation planning
// library. A single indivisible assignment of orders to lines must stay
// feasible under two public capacity scenarios at the same time, and the
// objective is to minimize the worse of the two scenario costs.
package transport

import "fmt"

const (
	// MaxOrders is the largest supported number of orders.
	MaxOrders = 8
	// MaxLines is the largest supported number of lines.
	MaxLines = 6
	// Scenarios is the number of public capacity scenarios.
	Scenarios = 2
)

// TimeWindow is a delivery time window [Earliest, Latest] (inclusive).
type TimeWindow struct {
	Earliest int
	Latest   int
}

// Order is an indivisible shipment that must be assigned to exactly one line.
type Order struct {
	ID     int
	Demand int
	Zone   int // temperature zone the order belongs to
	Window TimeWindow
}

// Line is a transport line that can carry orders of its temperature zone.
type Line struct {
	ID        int
	Capacity  [Scenarios]int // public capacity per scenario
	FixedCost int            // activation cost, paid once if the line is used
	Zone      int            // temperature zone the line serves
	Travel    [Scenarios]int // arrival time per scenario
}

// Problem describes a fixed-assignment planning instance.
type Problem struct {
	Orders []Order
	Lines  []Line
	// AssignCost[o][l][s] is the cost of assigning order o to line l in
	// scenario s.
	AssignCost [][][Scenarios]int
	// ZoneCap[z] is the shared capacity of temperature zone z across all
	// lines (e.g. a shared refrigerated vehicle pool).
	ZoneCap []int
	// Precedence holds pairs (i, j) meaning order i must be delivered no
	// later than order j in every scenario.
	Precedence [][2]int
}

// Validate checks structural limits and data consistency.
func (p *Problem) Validate() error {
	if len(p.Orders) == 0 {
		return fmt.Errorf("transport: no orders")
	}
	if len(p.Orders) > MaxOrders {
		return fmt.Errorf("transport: %d orders exceed limit %d", len(p.Orders), MaxOrders)
	}
	if len(p.Lines) == 0 {
		return fmt.Errorf("transport: no lines")
	}
	if len(p.Lines) > MaxLines {
		return fmt.Errorf("transport: %d lines exceed limit %d", len(p.Lines), MaxLines)
	}
	if len(p.AssignCost) != len(p.Orders) {
		return fmt.Errorf("transport: AssignCost has %d rows, want %d", len(p.AssignCost), len(p.Orders))
	}
	for o := range p.AssignCost {
		if len(p.AssignCost[o]) != len(p.Lines) {
			return fmt.Errorf("transport: AssignCost[%d] has %d entries, want %d", o, len(p.AssignCost[o]), len(p.Lines))
		}
	}
	for i, o := range p.Orders {
		if o.Zone < 0 || o.Zone >= len(p.ZoneCap) {
			return fmt.Errorf("transport: order %d (index %d) has invalid zone %d", o.ID, i, o.Zone)
		}
		if o.Window.Earliest > o.Window.Latest {
			return fmt.Errorf("transport: order %d (index %d) has empty time window", o.ID, i)
		}
	}
	for i, l := range p.Lines {
		if l.Zone < 0 || l.Zone >= len(p.ZoneCap) {
			return fmt.Errorf("transport: line %d (index %d) has invalid zone %d", l.ID, i, l.Zone)
		}
	}
	for k, pr := range p.Precedence {
		if pr[0] < 0 || pr[0] >= len(p.Orders) || pr[1] < 0 || pr[1] >= len(p.Orders) {
			return fmt.Errorf("transport: precedence pair %d out of range", k)
		}
	}
	return nil
}

// Objective maps a pair of scenario costs to the minimax objective value.
func Objective(c [Scenarios]int) int {
	if c[0] > c[1] {
		return c[0]
	}
	return c[1]
}

// Costs computes the total cost of an assignment in each scenario: the fixed
// activation cost of every used line plus the per-order assignment costs.
func (p *Problem) Costs(a []int) [Scenarios]int {
	var used [MaxLines]bool
	var c [Scenarios]int
	for o, l := range a {
		used[l] = true
		for s := 0; s < Scenarios; s++ {
			c[s] += p.AssignCost[o][l][s]
		}
	}
	for l := range p.Lines {
		if used[l] {
			for s := 0; s < Scenarios; s++ {
				c[s] += p.Lines[l].FixedCost
			}
		}
	}
	return c
}

// Check returns the list of constraint violations of an assignment, or nil
// when the assignment is feasible in both scenarios simultaneously.
func (p *Problem) Check(a []int) []string {
	var bad []string
	load := make([][Scenarios]int, len(p.Lines))
	zoneLoad := make([]int, len(p.ZoneCap))
	lineOf := make([]int, len(p.Orders))
	for o, l := range a {
		lineOf[o] = l
		if l < 0 || l >= len(p.Lines) {
			return append(bad, fmt.Sprintf("order %d assigned to invalid line %d", p.Orders[o].ID, l))
		}
		ord := &p.Orders[o]
		ln := &p.Lines[l]
		if ord.Zone != ln.Zone {
			bad = append(bad, fmt.Sprintf("order %d (zone %d) on line %d (zone %d)", ord.ID, ord.Zone, ln.ID, ln.Zone))
		}
		zoneLoad[ord.Zone] += ord.Demand
		for s := 0; s < Scenarios; s++ {
			load[l][s] += ord.Demand
			if ln.Travel[s] < ord.Window.Earliest || ln.Travel[s] > ord.Window.Latest {
				bad = append(bad, fmt.Sprintf("order %d on line %d: arrival %d outside window [%d,%d] in scenario %d",
					ord.ID, ln.ID, ln.Travel[s], ord.Window.Earliest, ord.Window.Latest, s))
			}
		}
	}
	for l, ln := range p.Lines {
		for s := 0; s < Scenarios; s++ {
			if load[l][s] > ln.Capacity[s] {
				bad = append(bad, fmt.Sprintf("line %d overloaded in scenario %d: %d > %d", ln.ID, s, load[l][s], ln.Capacity[s]))
			}
		}
	}
	for z := range p.ZoneCap {
		if zoneLoad[z] > p.ZoneCap[z] {
			bad = append(bad, fmt.Sprintf("zone %d shared capacity exceeded: %d > %d", z, zoneLoad[z], p.ZoneCap[z]))
		}
	}
	for _, pr := range p.Precedence {
		li, lj := lineOf[pr[0]], lineOf[pr[1]]
		for s := 0; s < Scenarios; s++ {
			if p.Lines[li].Travel[s] > p.Lines[lj].Travel[s] {
				bad = append(bad, fmt.Sprintf("precedence %d->%d violated in scenario %d: arrival %d > %d",
					p.Orders[pr[0]].ID, p.Orders[pr[1]].ID, s, p.Lines[li].Travel[s], p.Lines[lj].Travel[s]))
			}
		}
	}
	return bad
}

// Feasible reports whether the assignment satisfies every constraint in both
// scenarios. It is a fast early-exit check used by the exhaustive
// enumerator; use Check for human-readable diagnostics.
func (p *Problem) Feasible(a []int) bool {
	var load [MaxLines][Scenarios]int
	var lineOf [MaxOrders]int
	zoneLoad := make([]int, len(p.ZoneCap))
	for o, l := range a {
		if l < 0 || l >= len(p.Lines) {
			return false
		}
		lineOf[o] = l
		ord := &p.Orders[o]
		ln := &p.Lines[l]
		if ord.Zone != ln.Zone {
			return false
		}
		zoneLoad[ord.Zone] += ord.Demand
		if zoneLoad[ord.Zone] > p.ZoneCap[ord.Zone] {
			return false
		}
		for s := 0; s < Scenarios; s++ {
			load[l][s] += ord.Demand
			if load[l][s] > ln.Capacity[s] {
				return false
			}
			if ln.Travel[s] < ord.Window.Earliest || ln.Travel[s] > ord.Window.Latest {
				return false
			}
		}
	}
	for _, pr := range p.Precedence {
		for s := 0; s < Scenarios; s++ {
			if p.Lines[lineOf[pr[0]]].Travel[s] > p.Lines[lineOf[pr[1]]].Travel[s] {
				return false
			}
		}
	}
	return true
}
