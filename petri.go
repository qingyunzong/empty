// Package petri implements bounded Petri nets (up to MaxPlaces places, each
// with capacity Capacity) with guards, transition priorities and reset arcs,
// plus reachability analysis: shortest-trajectory search, full-closure
// enumeration, a naive BFS cross-check, an independent state enumerator and
// fair infinite-run (lasso) discovery.
package petri

const (
	// MaxPlaces is the maximum number of places in a net.
	MaxPlaces = 8
	// Capacity is the per-place token capacity (bounded net).
	Capacity = 4
)

// Marking is a fixed-size token vector; unused places stay zero so markings
// are comparable and usable as map keys.
type Marking [MaxPlaces]uint8

// Transition describes consumption/production tables plus optional guard,
// priority and reset arcs.
type Transition struct {
	Name string
	// Consume[p] tokens are removed from place p when firing.
	Consume [MaxPlaces]uint8
	// Produce[p] tokens are added to place p after consumption and resets.
	Produce [MaxPlaces]uint8
	// Reset[p] zeroes place p after the unified consumption step, before
	// production.
	Reset [MaxPlaces]bool
	// Priority: a transition may fire only when no enabled transition has a
	// strictly higher priority.
	Priority int
	// Guard, if non-nil, must hold for the transition to be enabled.
	Guard func(Marking) bool
}

// Net is a bounded Petri net.
type Net struct {
	// Places is the number of used places (<= MaxPlaces).
	Places int
	// Transitions is the transition set.
	Transitions []Transition
}

// Enabled reports whether t is enabled at m: enough tokens to consume and the
// guard (if any) holds. Capacity is checked in Fire, since overflow depends
// on the post-reset production step.
func (t *Transition) Enabled(m Marking) bool {
	for p := 0; p < MaxPlaces; p++ {
		if m[p] < t.Consume[p] {
			return false
		}
	}
	if t.Guard != nil && !t.Guard(m) {
		return false
	}
	return true
}

// Fire applies t to m: unified consumption first, then reset arcs, then
// production. It returns ok=false if any place would overflow Capacity; such
// a transition cannot fire.
func (t *Transition) Fire(m Marking) (next Marking, ok bool) {
	if !t.Enabled(m) {
		return Marking{}, false
	}
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
		if next[p] > Capacity {
			return Marking{}, false
		}
	}
	return next, true
}

// Fireable returns the indices of transitions that may actually fire at m:
// enabled, capacity-safe, and of maximal priority among the enabled ones.
func (n *Net) Fireable(m Marking) []int {
	maxPri := 0
	first := true
	for i := range n.Transitions {
		if !n.Transitions[i].Enabled(m) {
			continue
		}
		if first || n.Transitions[i].Priority > maxPri {
			maxPri = n.Transitions[i].Priority
			first = false
		}
	}
	var out []int
	for i := range n.Transitions {
		t := &n.Transitions[i]
		if !t.Enabled(m) || t.Priority < maxPri {
			continue
		}
		if _, ok := t.Fire(m); ok {
			out = append(out, i)
		}
	}
	return out
}

// Step is one fired edge: transition index plus resulting marking.
type Step struct {
	Trans int
	Next  Marking
}

// Successors returns all fireable edges out of m.
func (n *Net) Successors(m Marking) []Step {
	var out []Step
	for _, i := range n.Fireable(m) {
		next, ok := n.Transitions[i].Fire(m)
		if ok {
			out = append(out, Step{Trans: i, Next: next})
		}
	}
	return out
}
