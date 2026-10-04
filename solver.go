package routeinsert

import "math"

// Solve finds the insertion of all new stops into the fixed old sequence
// that minimizes extra travel distance while respecting precedence,
// capacity and time windows. It uses depth-first search over interleavings
// with incremental feasibility pruning and a distance bound, so it is
// exact. When no feasible insertion exists, Violations lists every rule
// that no interleaving can satisfy.
func Solve(p Problem) Result {
	s := &solver{
		p:       p,
		base:    RouteDistance(p.Vehicle, p.Old),
		best:    math.Inf(1),
		pickups: pickupOrders(p.Old, p.New),
		placed:  map[string]int{},
	}
	s.search(make([]Stop, 0, len(p.Old)+len(p.New)), 0, make([]bool, len(p.New)),
		p.Vehicle.Depart, 0, p.Vehicle.Start, 0)
	if math.IsInf(s.best, 1) {
		return Result{Feasible: false, Violations: violatedRules(p)}
	}
	return Result{Feasible: true, Seq: s.bestSeq, ExtraDistance: s.best}
}

type solver struct {
	p       Problem
	base    float64
	best    float64
	bestSeq []Stop
	pickups map[string]bool // orders that own a pickup stop
	placed  map[string]int  // orders whose pickup is in the current prefix
}

func (s *solver) search(seq []Stop, nextOld int, used []bool, t, load float64, loc Point, dist float64) {
	// Bound: the full route distance only grows from the prefix distance.
	if dist-s.base >= s.best {
		return
	}
	if nextOld == len(s.p.Old) && allUsed(used) {
		s.best = dist - s.base
		s.bestSeq = append([]Stop(nil), seq...)
		return
	}
	if nextOld < len(s.p.Old) {
		st := s.p.Old[nextOld]
		if s.deliverable(st) {
			s.tryAppend(st, seq, nextOld+1, used, t, load, loc, dist)
		}
		// An old stop that is not deliverable now can never become
		// deliverable later (its pickup lies further down the fixed old
		// order), so the whole instance is infeasible along this branch.
	}
	for i := range s.p.New {
		if used[i] {
			continue
		}
		st := s.p.New[i]
		if !s.deliverable(st) {
			continue
		}
		used[i] = true
		s.tryAppend(st, seq, nextOld, used, t, load, loc, dist)
		used[i] = false
	}
}

// deliverable reports whether st may be appended to the current prefix:
// a paired delivery requires its pickup to be placed already.
func (s *solver) deliverable(st Stop) bool {
	if st.Kind != Delivery || !s.pickups[st.Order] {
		return true
	}
	return s.placed[st.Order] > 0
}

func (s *solver) tryAppend(st Stop, seq []Stop, nextOld int, used []bool, t, load float64, loc Point, dist float64) {
	v := s.p.Vehicle
	dist += Dist(loc, st.Pos)
	t += Dist(loc, st.Pos) / v.Speed
	if t < st.Ready {
		t = st.Ready
	}
	if t > st.Due+eps {
		return // time windows only get tighter further along
	}
	load += st.Load
	if load > v.Capacity+eps || load < -eps {
		return // a prefix capacity violation cannot be repaired
	}
	t += st.Service
	if st.Kind == Pickup {
		s.placed[st.Order]++
	}
	s.search(append(seq, st), nextOld, used, t, load, st.Pos, dist)
	if st.Kind == Pickup {
		s.placed[st.Order]--
	}
}

func allUsed(used []bool) bool {
	for _, u := range used {
		if !u {
			return false
		}
	}
	return true
}

// violatedRules returns every rule that no interleaving of the new stops
// into the old sequence can satisfy (each rule checked in isolation).
func violatedRules(p Problem) []Rule {
	var out []Rule
	for _, r := range AllRules {
		if !existsSatisfying(p, r) {
			out = append(out, r)
		}
	}
	return out
}

// existsSatisfying reports whether some interleaving satisfies rule r,
// ignoring the other rules.
func existsSatisfying(p Problem, r Rule) bool {
	pickups := pickupOrders(p.Old, p.New)
	placed := map[string]int{}
	used := make([]bool, len(p.New))

	var rec func(nextOld int, t, load float64, loc Point) bool
	attempt := func(st Stop, nextOld int, t, load float64, loc Point) bool {
		switch r {
		case RulePrecedence:
			if st.Kind == Delivery && pickups[st.Order] && placed[st.Order] == 0 {
				return false
			}
		case RuleCapacity:
			l := load + st.Load
			if l > p.Vehicle.Capacity+eps || l < -eps {
				return false
			}
			load = l
		case RuleTimeWindow:
			t += Dist(loc, st.Pos) / p.Vehicle.Speed
			if t < st.Ready {
				t = st.Ready
			}
			if t > st.Due+eps {
				return false
			}
			t += st.Service
		}
		if st.Kind == Pickup {
			placed[st.Order]++
		}
		ok := rec(nextOld, t, load, st.Pos)
		if st.Kind == Pickup {
			placed[st.Order]--
		}
		return ok
	}
	rec = func(nextOld int, t, load float64, loc Point) bool {
		if nextOld == len(p.Old) && allUsed(used) {
			return true
		}
		if nextOld < len(p.Old) {
			if attempt(p.Old[nextOld], nextOld+1, t, load, loc) {
				return true
			}
		}
		for i := range p.New {
			if used[i] {
				continue
			}
			used[i] = true
			if attempt(p.New[i], nextOld, t, load, loc) {
				used[i] = false
				return true
			}
			used[i] = false
		}
		return false
	}
	return rec(0, p.Vehicle.Depart, 0, p.Vehicle.Start)
}
