// Package cirsim simulates digital circuits over the four-valued logic
// {0, 1, X, Z} with synchronous round-based updates of combinational
// (possibly cyclic) gate networks.
package cirsim

// Value is a four-valued logic level.
type Value byte

const (
	Zero Value = '0'
	One  Value = '1'
	X    Value = 'X' // unknown / conflicting
	Z    Value = 'Z' // high impedance
)

// String renders the value as one of "0", "1", "X", "Z".
func (v Value) String() string { return string(rune(v)) }

// IsValid reports whether v is one of the four logic values.
func (v Value) IsValid() bool {
	switch v {
	case Zero, One, X, Z:
		return true
	}
	return false
}
