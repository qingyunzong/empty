// Package matchcheck analyzes match expressions over finite enums, tuples
// and wildcard patterns. It reports unreachable branches and the minimal
// uncovered witness patterns. Guarded branches are never treated as
// guaranteeing coverage.
package matchcheck

// Type describes the shape of the scrutinee being matched.
type Type interface {
	// containsUnknown reports whether the type mentions Unknown anywhere.
	containsUnknown() bool
	// size returns the exact number of values of the type. It returns
	// ok=false when the type mentions Unknown or the count exceeds limit.
	size(limit int) (n int, ok bool)
}

// Enum is a finite sum type with named, payload-free variants.
type Enum struct {
	Name     string
	Variants []string
}

// Tuple is a product type of heterogeneous element types.
type Tuple struct {
	Elems []Type
}

// Unknown is a type whose value set is not known to the checker. A match
// over a type mentioning Unknown can never be reported exhaustive.
type Unknown struct{}

func (Enum) containsUnknown() bool    { return false }
func (Unknown) containsUnknown() bool { return true }

func (t Tuple) containsUnknown() bool {
	for _, e := range t.Elems {
		if e.containsUnknown() {
			return true
		}
	}
	return false
}

func (e Enum) size(limit int) (int, bool) {
	if len(e.Variants) > limit {
		return 0, false
	}
	return len(e.Variants), true
}

func (Unknown) size(int) (int, bool) { return 0, false }

func (t Tuple) size(limit int) (int, bool) {
	n := 1
	for _, e := range t.Elems {
		s, ok := e.size(limit)
		if !ok {
			return 0, false
		}
		n *= s
		if n > limit {
			return 0, false
		}
	}
	return n, true
}
