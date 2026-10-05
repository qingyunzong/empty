package clocksim

// Interval is an uncertainty window [Earliest, Latest] produced by a node's
// clock. The true "now" is guaranteed to lie somewhere inside it.
type Interval struct {
	Earliest int64
	Latest   int64
}

// Overlaps reports whether two intervals share any point in time.
func (i Interval) Overlaps(o Interval) bool {
	return i.Earliest <= o.Latest && o.Earliest <= i.Latest
}

// Before reports whether i is strictly in the past relative to o: every
// possible "now" in i precedes every possible "now" in o.
func (i Interval) Before(o Interval) bool {
	return i.Latest < o.Earliest
}
