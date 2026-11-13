package dataeng

import "time"

// OutputKind identifies the three records a Processor can emit.
type OutputKind uint8

const (
	// KindResult is an aggregate for a closed or corrected window.
	KindResult OutputKind = iota + 1
	// KindRetraction withdraws the immediately preceding result for the
	// same key and window. Value and Count are the withdrawn values.
	KindRetraction
	// KindSideOutput is an event that was too late to affect its window.
	KindSideOutput
)

// String implements fmt.Stringer.
func (k OutputKind) String() string {
	switch k {
	case KindResult:
		return "result"
	case KindRetraction:
		return "retraction"
	case KindSideOutput:
		return "side-output"
	default:
		return "unknown"
	}
}

// ReasonPastAllowedLateness is the Reason reported for a side output.
const ReasonPastAllowedLateness = "past_allowed_lateness"

// Output is a record produced by the processor. The fields that apply
// depend on Kind:
//
//   - KindResult and KindRetraction: Key, Window, Value, Count, Version and
//     ProcessingTime are set; Watermark is the watermark at emission.
//   - KindSideOutput: Key, Window, Event, Watermark, Reason and
//     ProcessingTime are set.
//
// A correction is emitted as a KindRetraction containing the previous
// values immediately followed by a KindResult containing the new values.
type Output struct {
	Kind           OutputKind
	Key            string
	Window         Window
	Value          int64
	Count          int64
	Version        int
	Event          Event
	Watermark      time.Time
	Reason         string
	ProcessingTime time.Time
}

// IsResult reports whether o is a window result.
func (o Output) IsResult() bool {
	return o.Kind == KindResult
}

// IsRetraction reports whether o withdraws a previous result.
func (o Output) IsRetraction() bool {
	return o.Kind == KindRetraction
}

// IsSideOutput reports whether o is a too-late event.
func (o Output) IsSideOutput() bool {
	return o.Kind == KindSideOutput
}

// Effect returns the additive contribution of o for consumers that apply
// records in order: +Value for a result, -Value for a retraction, and zero
// for a side output.
func (o Output) Effect() int64 {
	switch o.Kind {
	case KindResult:
		return o.Value
	case KindRetraction:
		return -o.Value
	default:
		return 0
	}
}
