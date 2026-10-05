// Package petri simulates bounded Petri nets with up to MaxPlaces places.
// It supports guards, transition priorities and reset arcs, and provides
// BFS-based reachability with shortest-path certificates, full state-space
// closures, a naive BFS baseline, and fair infinite-run (prefix+cycle)
// certificates.
package petri

import "fmt"

// MaxPlaces is the maximum number of places a net may have.
const MaxPlaces = 8

// DefaultCapacity is the token capacity applied to every place by NewNet.
const DefaultCapacity = 4

// Marking is a fixed-size token vector; only the first Net.Places entries
// are meaningful, which keeps Marking comparable and usable as a map key.
type Marking [MaxPlaces]uint8

// Transition describes consumption, production, reset arcs, an optional
// guard and a priority. Higher priority wins: a transition may only fire
// when no enabled transition of strictly higher priority exists.
type Transition struct {
	Name    string
	Consume [MaxPlaces]uint8
	Produce [MaxPlaces]uint8
	// Reset lists places emptied by a reset arc. Resetting happens after
	// the unified consumption step and before production.
	Reset [MaxPlaces]bool
	// Guard, if non-nil, must hold on the current marking for the
	// transition to be enabled.
	Guard func(Marking) bool
	// Priority: higher values take precedence over lower ones.
	Priority int
}

// Net is a bounded Petri net.
type Net struct {
	Places      int
	Capacities  [MaxPlaces]uint8
	Transitions []Transition
}

// NewNet creates a net with the given number of places (<= MaxPlaces),
// every place having DefaultCapacity.
func NewNet(places int) *Net {
	n := &Net{Places: places}
	for p := 0; p < places; p++ {
		n.Capacities[p] = DefaultCapacity
	}
	return n
}

// Validate checks structural constraints of the net.
func (n *Net) Validate() error {
	if n.Places < 1 || n.Places > MaxPlaces {
		return fmt.Errorf("petri: places %d out of range [1,%d]", n.Places, MaxPlaces)
	}
	for p := 0; p < n.Places; p++ {
		if n.Capacities[p] == 0 {
			return fmt.Errorf("petri: place %d has zero capacity", p)
		}
	}
	for i := range n.Transitions {
		t := &n.Transitions[i]
		for p := n.Places; p < MaxPlaces; p++ {
			if t.Consume[p] != 0 || t.Produce[p] != 0 || t.Reset[p] {
				return fmt.Errorf("petri: transition %q touches place %d >= Places", t.Name, p)
			}
		}
	}
	return nil
}

// InBounds reports whether m respects the place capacities.
func (n *Net) InBounds(m Marking) bool {
	for p := 0; p < n.Places; p++ {
		if m[p] > n.Capacities[p] {
			return false
		}
	}
	return true
}

// fire computes the successor marking of t at m. The order is: unified
// consumption of all inputs, then reset arcs empty their places, then
// production. A firing that would exceed any place capacity is not
// fireable at all (capacity overflow blocks the transition).
func (n *Net) fire(t *Transition, m Marking) (Marking, bool) {
	if t.Guard != nil && !t.Guard(m) {
		return m, false
	}
	var next Marking
	for p := 0; p < n.Places; p++ {
		if m[p] < t.Consume[p] {
			return m, false
		}
		next[p] = m[p] - t.Consume[p]
	}
	for p := 0; p < n.Places; p++ {
		if t.Reset[p] {
			next[p] = 0
		}
	}
	for p := 0; p < n.Places; p++ {
		next[p] += t.Produce[p]
		if next[p] > n.Capacities[p] {
			return m, false
		}
	}
	return next, true
}

// Firing is one fireable transition together with its successor marking.
type Firing struct {
	Transition int
	Next       Marking
}

// Fireable returns the transitions that may actually fire at m, applying
// priority filtering: only enabled transitions of the highest enabled
// priority are returned. Capacity-overflowing transitions count as not
// enabled.
func (n *Net) Fireable(m Marking) []Firing {
	type cand struct {
		idx  int
		next Marking
	}
	var cands []cand
	maxPri := 0
	for i := range n.Transitions {
		next, ok := n.fire(&n.Transitions[i], m)
		if !ok {
			continue
		}
		pri := n.Transitions[i].Priority
		if len(cands) == 0 || pri > maxPri {
			maxPri = pri
		}
		cands = append(cands, cand{i, next})
	}
	var out []Firing
	for _, c := range cands {
		if n.Transitions[c.idx].Priority == maxPri {
			out = append(out, Firing{Transition: c.idx, Next: c.next})
		}
	}
	return out
}

// Fire applies transition idx to m, honouring priority filtering, and
// returns the successor marking.
func (n *Net) Fire(m Marking, idx int) (Marking, bool) {
	for _, f := range n.Fireable(m) {
		if f.Transition == idx {
			return f.Next, true
		}
	}
	return m, false
}
