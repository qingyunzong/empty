package routeinsert

import "math"

const eps = 1e-9

// Dist returns the Euclidean distance between two points.
func Dist(a, b Point) float64 { return math.Hypot(a.X-b.X, a.Y-b.Y) }

// RouteDistance sums the travel distance of a sequence starting at the depot.
func RouteDistance(v Vehicle, seq []Stop) float64 {
	d := 0.0
	loc := v.Start
	for _, s := range seq {
		d += Dist(loc, s.Pos)
		loc = s.Pos
	}
	return d
}

// pickupOrders returns the set of order IDs that have a pickup stop among
// the given stops. Precedence is enforced only for these orders; a delivery
// without a matching pickup is treated as loaded at the depot.
func pickupOrders(stops ...[]Stop) map[string]bool {
	set := map[string]bool{}
	for _, ss := range stops {
		for _, s := range ss {
			if s.Kind == Pickup {
				set[s.Order] = true
			}
		}
	}
	return set
}

// Simulate evaluates a full sequence and reports every violated rule.
// Time is simulated with waiting: arriving before Ready waits until Ready;
// starting service after Due violates RuleTimeWindow. Load must stay within
// [0, Capacity]. Precedence requires each paired pickup to precede its
// delivery.
func Simulate(v Vehicle, seq []Stop) (dist float64, violated map[Rule]bool) {
	violated = map[Rule]bool{}

	pickIdx := map[string]int{}
	delIdx := map[string]int{}
	for i, s := range seq {
		switch s.Kind {
		case Pickup:
			if _, ok := pickIdx[s.Order]; !ok {
				pickIdx[s.Order] = i
			}
		case Delivery:
			if _, ok := delIdx[s.Order]; !ok {
				delIdx[s.Order] = i
			}
		}
	}
	for order, di := range delIdx {
		if pi, ok := pickIdx[order]; ok && pi > di {
			violated[RulePrecedence] = true
		}
	}

	t := v.Depart
	load := 0.0
	loc := v.Start
	for _, s := range seq {
		d := Dist(loc, s.Pos)
		dist += d
		t += d / v.Speed
		if t < s.Ready {
			t = s.Ready
		}
		if t > s.Due+eps {
			violated[RuleTimeWindow] = true
		}
		load += s.Load
		if load > v.Capacity+eps || load < -eps {
			violated[RuleCapacity] = true
		}
		t += s.Service
		loc = s.Pos
	}
	return dist, violated
}
