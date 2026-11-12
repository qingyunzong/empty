package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidDescriptor marks a descriptor outside the supported F/X/Y range.
	ErrInvalidDescriptor = errors.New("invalid descriptor")
	// ErrReservedFactor marks a dedicated replication-factor descriptor used
	// anywhere other than immediately after a delayed replication descriptor.
	ErrReservedFactor = errors.New("dedicated factor descriptor outside replication")
	// ErrReplicationBoundary marks a replication whose X raw descriptor
	// positions end inside a nested factor or replication body.
	ErrReplicationBoundary = errors.New("replication boundary cuts a nested factor or body")
	// ErrInvalidReplication marks a replication with X == 0 or a malformed
	// delayed-replication factor descriptor.
	ErrInvalidReplication = errors.New("invalid replication")
	// ErrInvalidOperator marks F=2 with an X other than 1 or 2.
	ErrInvalidOperator = errors.New("invalid operator")
	// ErrUnknownElement marks an F=0 descriptor missing from the element table.
	ErrUnknownElement = errors.New("unknown element descriptor")
	// ErrUnknownSequence marks an F=3 descriptor missing from the sequence table.
	ErrUnknownSequence = errors.New("unknown sequence descriptor")
	// ErrSequenceCycle marks a reachable cycle in the sequence-reference graph.
	ErrSequenceCycle = errors.New("reachable sequence cycle")
	// ErrInvalidElement marks an invalid element-table definition.
	ErrInvalidElement   = errors.New("invalid element definition")
	ErrInvalidBits      = errors.New("invalid bit string")
	ErrBitUnderflow     = errors.New("bit string exhausted")
	ErrInvalidFactor    = errors.New("invalid replication factor")
	ErrEffectiveWidth   = errors.New("effective element width outside 1..64")
	ErrStepLimit        = errors.New("maximum descriptor execution steps exceeded")
	ErrObservationLimit = errors.New("maximum output observations exceeded")
	ErrDepthLimit       = errors.New("maximum nesting depth exceeded")
	ErrInvalidPadding   = errors.New("invalid trailing padding")
	ErrInvalidOptions   = errors.New("invalid decode options")
)

// Descriptor is one BUFR-style F/X/Y descriptor triple.
//
// Only F=0 (element), F=1 (replication), F=2 (operator), and F=3 (sequence)
// are supported. X is in 0..63 and Y is in 0..255.
type Descriptor struct {
	F int
	X int
	Y int
}

// NewDescriptor validates and constructs a descriptor.
func NewDescriptor(f, x, y int) (Descriptor, error) {
	d := Descriptor{F: f, X: x, Y: y}
	if err := d.Validate(); err != nil {
		return Descriptor{}, err
	}
	return d, nil
}

// MustDescriptor constructs a descriptor and panics if it is invalid. It is
// convenient for static tables in examples and tests.
func MustDescriptor(f, x, y int) Descriptor {
	d, err := NewDescriptor(f, x, y)
	if err != nil {
		panic(err)
	}
	return d
}

// Validate checks the supported F/X/Y ranges.
func (d Descriptor) Validate() error {
	if d.F < 0 || d.F > 3 {
		return fmt.Errorf("%w: F=%d outside 0..3", ErrInvalidDescriptor, d.F)
	}
	if d.X < 0 || d.X > 63 {
		return fmt.Errorf("%w: X=%d outside 0..63", ErrInvalidDescriptor, d.X)
	}
	if d.Y < 0 || d.Y > 255 {
		return fmt.Errorf("%w: Y=%d outside 0..255", ErrInvalidDescriptor, d.Y)
	}
	return nil
}

// String renders the descriptor in the conventional F-X-Y notation with
// two- and three-digit X/Y fields.
func (d Descriptor) String() string {
	return fmt.Sprintf("%d-%02d-%03d", d.F, d.X, d.Y)
}

// ElementKey identifies an F=0 element by its X/Y fields.
type ElementKey struct {
	X int
	Y int
}

// SequenceKey identifies an F=3 sequence by its X/Y fields.
type SequenceKey struct {
	X int
	Y int
}

// ElementTable maps F=0 X/Y keys to element definitions.
type ElementTable map[ElementKey]ElementDef

// SequenceTable maps F=3 X/Y keys to raw descriptor lists.
type SequenceTable map[SequenceKey][]Descriptor

// IsFactor reports whether d is one of the two dedicated delayed-replication
// factor descriptors, 0-31-001 (8 bits) or 0-31-002 (16 bits).
func (d Descriptor) IsFactor() bool {
	return d.F == 0 && d.X == 31 && (d.Y == 1 || d.Y == 2)
}

// Element returns the ELEMENT key for an F=0 descriptor.
func (d Descriptor) Element() ElementKey {
	return ElementKey{X: d.X, Y: d.Y}
}

// Sequence returns the SEQUENCE key for an F=3 descriptor.
func (d Descriptor) Sequence() SequenceKey {
	return SequenceKey{X: d.X, Y: d.Y}
}
