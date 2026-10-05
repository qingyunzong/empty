// Package circsim simulates synchronous digital circuits over the
// four-state logic values 0, 1, X (unknown) and Z (high impedance).
package circsim

// Value is a four-state logic value.
type Value uint8

const (
	Zero Value = iota
	One
	X // unknown
	Z // high impedance
)

func (v Value) String() string {
	switch v {
	case Zero:
		return "0"
	case One:
		return "1"
	case X:
		return "X"
	case Z:
		return "Z"
	}
	return "?"
}

// Resolve combines two drivers on the same net. Z is the identity
// (an undriven contribution), equal values agree, and any other
// conflict (including 0 against 1) yields X.
func Resolve(a, b Value) Value {
	if a == Z {
		return b
	}
	if b == Z {
		return a
	}
	if a == b {
		return a
	}
	return X
}
