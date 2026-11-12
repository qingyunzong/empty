package dataeng

import (
	"fmt"
	"math/big"
)

// ElementDef defines an F=0 element. Scale is the base decimal scale in
// -64..64, BitWidth is the base width in 1..64, and Reference is an arbitrary
// precision signed integer.
type ElementDef struct {
	Name      string
	BitWidth  int
	Scale     int
	Reference *big.Int
}

// NewElementDef validates and constructs an element definition. The reference
// is copied, so later mutation of the caller's big.Int cannot alter a table.
func NewElementDef(name string, bitWidth, scale int, reference *big.Int) (ElementDef, error) {
	e := ElementDef{
		Name:      name,
		BitWidth:  bitWidth,
		Scale:     scale,
		Reference: reference,
	}
	if err := e.Validate(); err != nil {
		return ElementDef{}, err
	}
	e.Reference = new(big.Int).Set(reference)
	return e, nil
}

// Validate checks the element definition limits.
func (e ElementDef) Validate() error {
	if e.BitWidth < 1 || e.BitWidth > 64 {
		return fmt.Errorf("%w: bit width %d outside 1..64", ErrInvalidElement, e.BitWidth)
	}
	if e.Scale < -64 || e.Scale > 64 {
		return fmt.Errorf("%w: scale %d outside -64..64", ErrInvalidElement, e.Scale)
	}
	if e.Reference == nil {
		return fmt.Errorf("%w: nil arbitrary-precision reference", ErrInvalidElement)
	}
	return nil
}

// ElementID is the stable identifier emitted for an observed element.
type ElementID struct {
	X    int
	Y    int
	Name string
}

// Descriptor returns the F=0 descriptor corresponding to the identifier.
func (id ElementID) Descriptor() Descriptor {
	return Descriptor{F: 0, X: id.X, Y: id.Y}
}

// PathKind identifies a nesting layer in an observation path.
type PathKind uint8

const (
	// PathSequence is an active F=3 sequence expansion.
	PathSequence PathKind = iota + 1
	// PathReplication is one iteration of an F=1 body. Iteration is 1-based.
	PathReplication
)

// String returns a stable, human-readable path-kind name.
func (k PathKind) String() string {
	switch k {
	case PathSequence:
		return "sequence"
	case PathReplication:
		return "replication"
	default:
		return "unknown"
	}
}

// PathStep identifies one active sequence or replication layer. Iteration is
// 1-based for replication and 0 for a sequence (sequences are not repeated by
// themselves).
type PathStep struct {
	Kind       PathKind
	Descriptor Descriptor
	Iteration  int
}

// Observation is one emitted element occurrence. A repeated element produces
// one Observation per occurrence; it never overwrites another occurrence.
//
// BitStart is inclusive and BitEnd is exclusive, both zero-based within the
// complete input bit stream. Subset is 1-based. Value is a canonical
// arbitrary-precision rational and is nil exactly when Missing is true.
type Observation struct {
	Subset   int
	Element  ElementID
	Path     []PathStep
	BitStart int
	BitEnd   int
	Raw      uint64
	Missing  bool
	Value    *big.Rat
}

// RationalString renders the exact observation value as a canonical rational
// ("n" or "n/d"), or "missing".
func (o Observation) RationalString() string {
	if o.Missing {
		return "missing"
	}
	if o.Value == nil {
		return ""
	}
	return o.Value.RatString()
}
