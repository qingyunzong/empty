package formal

// Verdict is the tail-sampling outcome for a trace.
type Verdict uint8

const (
	// Undecided means that the trace is still collecting fragments.
	Undecided Verdict = iota
	// Keep means that the trace must be exported.
	Keep
	// Drop means that the trace must not be exported.
	Drop
)

// String returns the lower-case name of the verdict.
func (v Verdict) String() string {
	switch v {
	case Keep:
		return "keep"
	case Drop:
		return "drop"
	case Undecided:
		return "undecided"
	default:
		return "invalid"
	}
}

// Valid reports whether v is a final verdict.
func (v Verdict) Valid() bool {
	return v == Keep || v == Drop
}
