// Package mvregister implements a multi-value register CRDT whose writes are
// ordered by causal vectors (vector clocks).
package mvregister

// Relation describes the causal relation between two vector clocks.
type Relation int

const (
	Equal Relation = iota
	Before
	After
	Concurrent
)

func (r Relation) String() string {
	switch r {
	case Equal:
		return "equal"
	case Before:
		return "before"
	case After:
		return "after"
	default:
		return "concurrent"
	}
}

// VectorClock is a causal vector mapping replica IDs to logical counters.
type VectorClock map[string]uint64

// Copy returns a deep copy of the clock.
func (vc VectorClock) Copy() VectorClock {
	out := make(VectorClock, len(vc))
	for id, n := range vc {
		out[id] = n
	}
	return out
}

// Merge returns the element-wise maximum of both clocks (the least upper
// bound), leaving the receivers unchanged.
func (vc VectorClock) Merge(other VectorClock) VectorClock {
	out := vc.Copy()
	for id, n := range other {
		if n > out[id] {
			out[id] = n
		}
	}
	return out
}

// Compare returns the causal relation of a to b.
func Compare(a, b VectorClock) Relation {
	aLe, bLe := true, true
	for id, n := range a {
		if n > b[id] {
			aLe = false
		}
	}
	for id, n := range b {
		if n > a[id] {
			bLe = false
		}
	}
	switch {
	case aLe && bLe:
		return Equal
	case aLe:
		return Before
	case bLe:
		return After
	default:
		return Concurrent
	}
}
