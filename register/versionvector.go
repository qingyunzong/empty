// Package register implements a replicated multi-value register (MV-Register)
// that uses version vectors (causal vectors) to compare writes.
//
// Semantics:
//   - A causally-later write overwrites causally-earlier writes.
//   - Concurrent writes are all preserved and exposed by replica ID.
//   - A resolving write must observe all currently visible versions.
//   - Merge is commutative, associative, idempotent, and never loses
//     concurrent writes.
package register

// Ordering describes the causal relationship between two version vectors.
type Ordering int

const (
	Equal Ordering = iota
	Before
	After
	Concurrent
)

func (o Ordering) String() string {
	switch o {
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

// VersionVector is a causal vector mapping replica IDs to logical clocks.
type VersionVector map[string]uint64

// Clone returns a deep copy of the vector.
func (v VersionVector) Clone() VersionVector {
	out := make(VersionVector, len(v))
	for id, n := range v {
		out[id] = n
	}
	return out
}

// Compare returns the causal ordering of v relative to other.
func (v VersionVector) Compare(other VersionVector) Ordering {
	less, greater := false, false
	for id, n := range v {
		m := other[id]
		if n < m {
			less = true
		} else if n > m {
			greater = true
		}
	}
	for id, m := range other {
		if _, ok := v[id]; !ok && m > 0 {
			less = true
		}
	}
	switch {
	case less && greater:
		return Concurrent
	case less:
		return Before
	case greater:
		return After
	default:
		return Equal
	}
}

// Merge returns the element-wise maximum (join) of both vectors.
func (v VersionVector) Merge(other VersionVector) VersionVector {
	out := v.Clone()
	for id, n := range other {
		if n > out[id] {
			out[id] = n
		}
	}
	return out
}

// dominates reports whether v is causally at or after other.
func (v VersionVector) dominates(other VersionVector) bool {
	return v.Compare(other) == After || v.Compare(other) == Equal
}
