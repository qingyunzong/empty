package petri

// This file is a third, independent implementation of the firing semantics,
// used only to cross-check Closure and NaiveClosure. It enumerates reachable
// states by plain recursion with a map, deriving successors its own way.

func enumFireable(n *Net, m Marking) []int {
	// Highest priority among transitions whose preconditions hold.
	haveAny := false
	top := 0
	for i := range n.Transitions {
		t := &n.Transitions[i]
		ok := true
		for p := 0; p < MaxPlaces; p++ {
			if m[p] < t.Consume[p] {
				ok = false
				break
			}
		}
		if ok && t.Guard != nil {
			ok = t.Guard(m)
		}
		if !ok {
			continue
		}
		if !haveAny || t.Priority > top {
			top = t.Priority
			haveAny = true
		}
	}
	var out []int
	for i := range n.Transitions {
		t := &n.Transitions[i]
		if t.Priority != top {
			continue
		}
		// Apply: subtract, reset, add, capacity check.
		var next Marking
		ok := true
		for p := 0; p < MaxPlaces; p++ {
			if m[p] < t.Consume[p] {
				ok = false
				break
			}
			next[p] = m[p] - t.Consume[p]
		}
		if !ok {
			continue
		}
		if t.Guard != nil && !t.Guard(m) {
			continue
		}
		for p := 0; p < MaxPlaces; p++ {
			if t.Reset[p] {
				next[p] = 0
			}
		}
		for p := 0; p < MaxPlaces; p++ {
			next[p] += t.Produce[p]
			if next[p] > Capacity {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, i)
		}
	}
	return out
}

// Enumerate independently computes the reachable state set from initial.
func (n *Net) Enumerate(initial Marking) map[Marking]bool {
	seen := map[Marking]bool{}
	var visit func(m Marking)
	visit = func(m Marking) {
		if seen[m] {
			return
		}
		seen[m] = true
		for _, i := range enumFireable(n, m) {
			t := &n.Transitions[i]
			var next Marking
			for p := 0; p < MaxPlaces; p++ {
				next[p] = m[p] - t.Consume[p]
			}
			for p := 0; p < MaxPlaces; p++ {
				if t.Reset[p] {
					next[p] = 0
				}
			}
			for p := 0; p < MaxPlaces; p++ {
				next[p] += t.Produce[p]
			}
			visit(next)
		}
	}
	visit(initial)
	return seen
}
