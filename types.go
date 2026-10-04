// Package routeinsert solves the single-vehicle fixed-sequence insertion
// problem: a depot keeps a route whose existing stops must be served in
// their current relative order; stops of new orders (each a pickup and a
// delivery) may be inserted at arbitrary positions as long as the old
// relative order is preserved. Insertions must respect pickup-before-
// delivery precedence, vehicle capacity and stop time windows. The
// objective is to minimize the extra travel distance caused by the
// insertion. When no feasible insertion exists, the set of violated
// rules is reported.
package routeinsert

// Rule identifies a feasibility constraint.
type Rule string

const (
	// RulePrecedence requires a pickup to be served before its delivery.
	RulePrecedence Rule = "precedence"
	// RuleCapacity requires the vehicle load to stay within [0, Capacity].
	RuleCapacity Rule = "capacity"
	// RuleTimeWindow requires service to start no later than Due.
	RuleTimeWindow Rule = "time_window"
)

// AllRules lists every enforced rule in a stable order.
var AllRules = []Rule{RulePrecedence, RuleCapacity, RuleTimeWindow}

// Point is a planar coordinate.
type Point struct {
	X, Y float64
}

// Kind classifies a stop.
type Kind int

const (
	// Regular is a plain service stop with no pairing.
	Regular Kind = iota
	// Pickup adds Load to the vehicle.
	Pickup
	// Delivery removes Load from the vehicle; it shares Order with its pickup.
	Delivery
)

// Stop is a single visit on the route.
type Stop struct {
	ID      string
	Pos     Point
	Load    float64 // signed: + at pickup, - at delivery
	Ready   float64 // earliest service start (waiting is allowed)
	Due     float64 // latest service start
	Service float64 // service duration
	Order   string  // shared by a pickup/delivery pair
	Kind    Kind
}

// Vehicle describes the single vehicle.
type Vehicle struct {
	Capacity float64
	Start    Point // depot location
	Depart   float64
	Speed    float64 // distance units per time unit
}

// Problem is a full insertion instance. Old stops (at most 20) keep their
// relative order; every stop in New must be inserted exactly once.
type Problem struct {
	Vehicle Vehicle
	Old     []Stop
	New     []Stop
}

// Result is the outcome of Solve.
type Result struct {
	Feasible      bool
	Seq           []Stop  // full sequence with new stops inserted
	ExtraDistance float64 // route distance minus the old route distance
	Violations    []Rule  // rules no insertion can satisfy, when infeasible
}
