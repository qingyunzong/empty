package clocksim

import "fmt"

// SweepIntervals enumerates candidate read intervals of the given width
// whose Earliest runs from start to end inclusive, advancing by step.
// It is used to sweep read intervals across a commit window.
func SweepIntervals(start, end, width, step int64) []Interval {
	if step <= 0 || width < 0 {
		return nil
	}
	var ivs []Interval
	for e := start; e <= end; e += step {
		ivs = append(ivs, Interval{Earliest: e, Latest: e + width})
	}
	return ivs
}

// OverlappingCommit returns the intervals from ivs that overlap the
// write's commit interval, i.e. reads that may be concurrent with the
// commit and therefore must never observe the write.
func OverlappingCommit(w Write, ivs []Interval) []Interval {
	var out []Interval
	for _, iv := range ivs {
		if iv.Overlaps(w.Commit) {
			out = append(out, iv)
		}
	}
	return out
}

// Violation describes a read interval for which the store broke the
// visibility rule.
type Violation struct {
	At     Interval
	Detail string
}

func (v Violation) String() string { return fmt.Sprintf("at=%s: %s", v.At, v.Detail) }

// VerifyNoEarlyRead enumerates the intervals overlapping the write's
// commit window and checks that none of them is served the write. It
// also checks the dual: every interval whose Earliest is past the
// commit upper bound must observe the write. A nil result means the
// store never reads early and never withholds a due read.
func VerifyNoEarlyRead(s *Store, w Write, ivs []Interval) []Violation {
	var violations []Violation
	for _, iv := range ivs {
		res := s.Read(w.Key, iv)
		early := iv.Earliest <= w.CommitUpper()
		switch {
		case early && res.Outcome == Visible:
			violations = append(violations, Violation{At: iv,
				Detail: fmt.Sprintf("read served before commit upper %d", w.CommitUpper())})
		case !early && res.Outcome == Pending:
			violations = append(violations, Violation{At: iv,
				Detail: fmt.Sprintf("read withheld although earliest %d > commit upper %d",
					iv.Earliest, w.CommitUpper())})
		}
	}
	return violations
}
