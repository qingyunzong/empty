// Package insertion solves the single-vehicle fixed-order insertion problem:
// a vehicle already serves a fixed sequence of stops (the old order must not
// change); a new order consisting of one pickup and one delivery stop must be
// inserted into the sequence so that
//
//   - the pickup is served before the delivery (precedence),
//   - the vehicle capacity is never exceeded (capacity),
//   - every stop is served within its time window (time windows),
//
// and the extra travel distance caused by the insertion is minimized.
// The number of old stops is limited to MaxOldStops.
//
// If no feasible insertion exists, the result carries the set of constraint
// rules that were violated while enumerating all insertion positions.
package insertion

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// MaxOldStops is the maximum number of pre-existing stops on the route.
const MaxOldStops = 20

// Constraint rule identifiers reported when no feasible insertion exists.
const (
	RulePrecedence = "pickup_before_delivery"
	RuleCapacity   = "capacity"
	RuleTimeWindow = "time_window"
)

// Stop is a service location on the route.
type Stop struct {
	ID      string
	X, Y    float64
	Demand  int     // >0 loads the vehicle (pickup), <0 unloads (delivery)
	Ready   float64 // earliest service start (time window open)
	Due     float64 // latest service start (time window close)
	Service float64 // service duration
}

// Problem describes a fixed-order insertion instance.
type Problem struct {
	Depot       Stop    // only X, Y (and optionally Ready/Due) are used
	Stops       []Stop  // old stops, fixed service order, at most MaxOldStops
	Pickup      Stop    // new order pickup, Demand must be > 0
	Delivery    Stop    // new order delivery, Demand must be < 0
	Capacity    int     // vehicle capacity
	InitialLoad int     // load when leaving the depot
	StartTime   float64 // departure time from the depot
}

// Result is the outcome of an insertion search.
type Result struct {
	Feasible      bool
	PickupPos     int      // gap index in 0..len(Stops) where the pickup is inserted
	DeliveryPos   int      // gap index in PickupPos..len(Stops) where the delivery is inserted
	ExtraDistance float64  // additional distance versus the old route
	ViolatedRules []string // sorted set of violated rules, only when infeasible
}

// Validate checks the structural limits of the instance.
func (p *Problem) Validate() error {
	if len(p.Stops) > MaxOldStops {
		return fmt.Errorf("too many old stops: %d > %d", len(p.Stops), MaxOldStops)
	}
	if p.Pickup.Demand <= 0 {
		return errors.New("pickup demand must be positive")
	}
	if p.Delivery.Demand >= 0 {
		return errors.New("delivery demand must be negative")
	}
	if p.Capacity < 0 {
		return errors.New("capacity must be non-negative")
	}
	return nil
}

func dist(a, b Stop) float64 {
	return math.Hypot(a.X-b.X, a.Y-b.Y)
}

// routeNodes returns the node sequence of the old route including the depot
// at both ends: depot, stops..., depot.
func (p *Problem) routeNodes() []Stop {
	nodes := make([]Stop, 0, len(p.Stops)+2)
	nodes = append(nodes, p.Depot)
	nodes = append(nodes, p.Stops...)
	nodes = append(nodes, p.Depot)
	return nodes
}

func routeDistance(nodes []Stop) float64 {
	total := 0.0
	for i := 0; i+1 < len(nodes); i++ {
		total += dist(nodes[i], nodes[i+1])
	}
	return total
}

// buildRoute inserts the pickup at gap i and the delivery at gap j (i <= j)
// into the old stop sequence, preserving the old order, and returns the full
// node sequence including the depot at both ends.
func (p *Problem) buildRoute(i, j int) []Stop {
	route := make([]Stop, 0, len(p.Stops)+4)
	route = append(route, p.Depot)
	route = append(route, p.Stops[:i]...)
	route = append(route, p.Pickup)
	route = append(route, p.Stops[i:j]...)
	route = append(route, p.Delivery)
	route = append(route, p.Stops[j:]...)
	route = append(route, p.Depot)
	return route
}

// checkRoute simulates the route and reports the set of violated rules.
// The precedence rule is enforced structurally (only pickup-before-delivery
// insertions are ever built), so it can only be reported here if a route is
// constructed otherwise. An empty set means the route is feasible.
func (p *Problem) checkRoute(route []Stop) map[string]bool {
	violated := map[string]bool{}
	t := p.StartTime
	load := p.InitialLoad
	if load > p.Capacity {
		violated[RuleCapacity] = true
	}
	seenPickup := false
	for k := 1; k < len(route); k++ {
		prev, cur := route[k-1], route[k]
		t += dist(prev, cur)
		if cur.ID == p.Depot.ID && k == len(route)-1 {
			if p.Depot.Due > 0 && t > p.Depot.Due {
				violated[RuleTimeWindow] = true
			}
			break
		}
		if t < cur.Ready {
			t = cur.Ready // wait for the window to open
		}
		if t > cur.Due {
			violated[RuleTimeWindow] = true
		}
		if cur.ID == p.Pickup.ID {
			seenPickup = true
		}
		if cur.ID == p.Delivery.ID && !seenPickup {
			violated[RulePrecedence] = true
		}
		load += cur.Demand
		if load > p.Capacity || load < 0 {
			violated[RuleCapacity] = true
		}
		t += cur.Service
	}
	return violated
}

// extraDistance computes the added mileage of inserting the pickup at gap i
// and the delivery at gap j using only the local edge changes.
func (p *Problem) extraDistance(nodes []Stop, i, j int) float64 {
	a, b := nodes[i], nodes[i+1]
	if i == j {
		return dist(a, p.Pickup) + dist(p.Pickup, p.Delivery) + dist(p.Delivery, b) - dist(a, b)
	}
	c, d := nodes[j], nodes[j+1]
	return dist(a, p.Pickup) + dist(p.Pickup, b) - dist(a, b) +
		dist(c, p.Delivery) + dist(p.Delivery, d) - dist(c, d)
}

// BestInsertion enumerates every pair of insertion gaps (pickup gap i,
// delivery gap j, i <= j, old order preserved) and returns the feasible
// insertion with the minimum extra distance. Candidate cost is evaluated
// incrementally from local edge changes; feasibility is checked by route
// simulation. When no feasible insertion exists, ViolatedRules holds the
// union of rules violated across all candidates.
func (p *Problem) BestInsertion() (Result, error) {
	if err := p.Validate(); err != nil {
		return Result{}, err
	}
	nodes := p.routeNodes()
	n := len(p.Stops)
	best := Result{Feasible: false, ExtraDistance: math.Inf(1)}
	violatedAll := map[string]bool{}
	for i := 0; i <= n; i++ {
		for j := i; j <= n; j++ {
			violated := p.checkRoute(p.buildRoute(i, j))
			if len(violated) > 0 {
				for rule := range violated {
					violatedAll[rule] = true
				}
				continue
			}
			extra := p.extraDistance(nodes, i, j)
			if extra < best.ExtraDistance {
				best = Result{Feasible: true, PickupPos: i, DeliveryPos: j, ExtraDistance: extra}
			}
		}
	}
	if !best.Feasible {
		best.ExtraDistance = 0
		best.ViolatedRules = sortedRules(violatedAll)
	}
	return best, nil
}

// BruteForceAll independently enumerates all insertion positions, rebuilding
// every candidate route from scratch and recomputing its full length. It is
// the reference implementation used to cross-check BestInsertion.
func (p *Problem) BruteForceAll() (Result, error) {
	if err := p.Validate(); err != nil {
		return Result{}, err
	}
	oldDistance := routeDistance(p.routeNodes())
	n := len(p.Stops)
	best := Result{Feasible: false, ExtraDistance: math.Inf(1)}
	violatedAll := map[string]bool{}
	for i := 0; i <= n; i++ {
		for j := i; j <= n; j++ {
			route := p.buildRoute(i, j)
			violated := p.checkRoute(route)
			if len(violated) > 0 {
				for rule := range violated {
					violatedAll[rule] = true
				}
				continue
			}
			extra := routeDistance(route) - oldDistance
			if extra < best.ExtraDistance {
				best = Result{Feasible: true, PickupPos: i, DeliveryPos: j, ExtraDistance: extra}
			}
		}
	}
	if !best.Feasible {
		best.ExtraDistance = 0
		best.ViolatedRules = sortedRules(violatedAll)
	}
	return best, nil
}

func sortedRules(set map[string]bool) []string {
	rules := make([]string, 0, len(set))
	for rule := range set {
		rules = append(rules, rule)
	}
	sort.Strings(rules)
	return rules
}
