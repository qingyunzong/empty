package clocksim

import "fmt"

// ReadEvent records one served (or attempted) read for later verification.
type ReadEvent struct {
	ReaderID string
	WriterID string
	Key      string
	// ReaderInterval is the reader's clock interval at the moment the read
	// was evaluated.
	ReaderInterval Interval
	// Commit is the commit interval of the value that was read.
	Commit Interval
	// Served is true if the value was actually returned to the caller.
	Served bool
}

// Violation describes a read that was served too early: the reader's
// interval still overlapped the write's commit upper bound.
type Violation struct {
	Event  ReadEvent
	Reason string
}

func (v Violation) String() string {
	return fmt.Sprintf("reader=%s writer=%s key=%s: %s (reader=[%d,%d] commit=[%d,%d])",
		v.Event.ReaderID, v.Event.WriterID, v.Event.Key, v.Reason,
		v.Event.ReaderInterval.Earliest, v.Event.ReaderInterval.Latest,
		v.Event.Commit.Earliest, v.Event.Commit.Latest)
}

// OverlapPair is a pair of read events whose reader interval and commit
// interval overlap in time — the cases where an early read would be possible.
type OverlapPair struct {
	ReaderID string
	WriterID string
	Key      string
	Reader   Interval
	Commit   Interval
	Served   bool
}

// EnumerateOverlaps returns every read event whose reader interval overlaps
// the commit interval of the value it read. These are exactly the events for
// which Served must be false.
func EnumerateOverlaps(events []ReadEvent) []OverlapPair {
	var pairs []OverlapPair
	for _, e := range events {
		if e.ReaderInterval.Overlaps(e.Commit) {
			pairs = append(pairs, OverlapPair{
				ReaderID: e.ReaderID,
				WriterID: e.WriterID,
				Key:      e.Key,
				Reader:   e.ReaderInterval,
				Commit:   e.Commit,
				Served:   e.Served,
			})
		}
	}
	return pairs
}

// Verify checks every read event: a served read is valid only if the
// reader's earliest possible "now" was strictly later than the commit upper
// bound. It returns one violation per offending event.
func Verify(events []ReadEvent) []Violation {
	var violations []Violation
	for _, e := range events {
		if e.Served && !VisibleAt(e.ReaderInterval, e.Commit) {
			violations = append(violations, Violation{
				Event:  e,
				Reason: "served before reader's earliest now passed the commit upper bound",
			})
		}
	}
	return violations
}
