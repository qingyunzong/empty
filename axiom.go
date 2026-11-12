package dataeng

import "fmt"

// Concept and Relation are aliases for string so host vocabularies can be
// passed without conversions.
type (
	Concept  = string
	Relation = string
)

// Top and Bottom are the reserved concepts. Top denotes the whole non-empty
// domain and Bottom denotes the empty set.
const (
	Top    Concept = "Top"
	Bottom Concept = "Bottom"
)

// AxiomKind identifies one of the four supported axiom shapes.
type AxiomKind uint8

const (
	// KindInclusion is A included in B.
	KindInclusion AxiomKind = iota
	// KindIntersectionInclusion is A1 and A2 included in B.
	KindIntersectionInclusion
	// KindExistentialInclusion is A included in exists R.B.
	KindExistentialInclusion
	// KindExistentialSubsumption is exists R.A included in B.
	KindExistentialSubsumption
)

// Convenience aliases for the axiom kinds.
const (
	InclusionAxiom              = KindInclusion
	IntersectionAxiom           = KindIntersectionInclusion
	ExistentialAxiom            = KindExistentialInclusion
	ExistentialSubsumptionAxiom = KindExistentialSubsumption
)

// Axiom is a normalised input axiom.
//
// The fields used by each kind are:
//
//	KindInclusion:              A, B
//	KindIntersectionInclusion:  A1, A2, B
//	KindExistentialInclusion:   A, R, B
//	KindExistentialSubsumption: R, A, B
//
// Every non-relation field must be a declared concept name or Top/Bottom.
type Axiom struct {
	ID   string
	Kind AxiomKind

	A  string
	B  string
	A1 string
	A2 string
	R  string
}

// Include constructs an A included in B axiom.
func Include(id, a, b string) Axiom {
	return Axiom{ID: id, Kind: KindInclusion, A: a, B: b}
}

// Intersect constructs an A1 and A2 included in B axiom.
func Intersect(id, a1, a2, b string) Axiom {
	return Axiom{ID: id, Kind: KindIntersectionInclusion, A1: a1, A2: a2, B: b}
}

// Exists constructs an A included in exists R.B axiom.
func Exists(id, a, r, b string) Axiom {
	return Axiom{ID: id, Kind: KindExistentialInclusion, A: a, R: r, B: b}
}

// ExistsSubsumed constructs an exists R.A included in B axiom.
func ExistsSubsumed(id, r, a, b string) Axiom {
	return Axiom{ID: id, Kind: KindExistentialSubsumption, A: a, B: b, R: r}
}

// Inclusion, Intersection, Existential, and ExistentialSubsumption are
// descriptive aliases for the four constructors above.
func Inclusion(id, a, b string) Axiom {
	return Include(id, a, b)
}

func Intersection(id, a1, a2, b string) Axiom {
	return Intersect(id, a1, a2, b)
}

func Existential(id, a, r, b string) Axiom {
	return Exists(id, a, r, b)
}

func ExistentialSubsumption(id, r, a, b string) Axiom {
	return ExistsSubsumed(id, r, a, b)
}

// Vocabulary declares the ordinary concept and relation names of a snapshot.
// Top and Bottom are always available and need not be listed.
type Vocabulary struct {
	Concepts  []string
	Relations []string
}

func (a Axiom) String() string {
	switch a.Kind {
	case KindInclusion:
		return fmt.Sprintf("%s: %s <= %s", a.ID, a.A, a.B)
	case KindIntersectionInclusion:
		return fmt.Sprintf("%s: %s and %s <= %s", a.ID, a.A1, a.A2, a.B)
	case KindExistentialInclusion:
		return fmt.Sprintf("%s: %s <= exists %s.%s", a.ID, a.A, a.R, a.B)
	case KindExistentialSubsumption:
		return fmt.Sprintf("%s: exists %s.%s <= %s", a.ID, a.R, a.A, a.B)
	default:
		return fmt.Sprintf("%s: invalid axiom kind %d", a.ID, a.Kind)
	}
}
