package clocksim

import (
	"errors"
	"fmt"
	"strings"
)

// Write is a committed write together with the uncertainty interval
// observed at commit time. The commit upper bound is Commit.Latest:
// the write is guaranteed committed everywhere only after that instant.
type Write struct {
	Key    string
	Value  string
	Commit Interval
}

// CommitUpper returns the write's commit upper bound.
func (w Write) CommitUpper() int64 { return w.Commit.Latest }

// Outcome is the result of a read or a wait.
type Outcome int

const (
	// Visible means the read observes the committed write.
	Visible Outcome = iota
	// Pending means the read cannot observe the write yet (or the wait
	// could not make progress) and must be retried later.
	Pending
)

func (o Outcome) String() string {
	if o == Visible {
		return "visible"
	}
	return "pending"
}

// ReadResult reports whether a read at a given interval observes a write.
type ReadResult struct {
	Outcome Outcome
	Write   Write
	At      Interval
	Reason  string
}

// Store holds committed writes keyed by string.
type Store struct {
	writes map[string]Write
}

// NewStore returns an empty store.
func NewStore() *Store { return &Store{writes: make(map[string]Write)} }

// Commit records a write committed while the committing node's clock
// read at. The commit interval must be valid.
func (s *Store) Commit(key, value string, at Interval) (Write, error) {
	if !at.Valid() {
		return Write{}, fmt.Errorf("clocksim: invalid commit interval %s", at)
	}
	w := Write{Key: key, Value: value, Commit: at}
	s.writes[key] = w
	return w, nil
}

// Write returns the committed write for key.
func (s *Store) Write(key string) (Write, bool) {
	w, ok := s.writes[key]
	return w, ok
}

// Read serves key as of interval at. The write is visible only when the
// reader's earliest possible now is strictly later than the write's
// commit upper bound; otherwise the read is pending.
func (s *Store) Read(key string, at Interval) ReadResult {
	w, ok := s.writes[key]
	if !ok {
		return ReadResult{Outcome: Pending, At: at, Reason: "no committed write for key"}
	}
	if at.Earliest > w.CommitUpper() {
		return ReadResult{Outcome: Visible, Write: w, At: at,
			Reason: fmt.Sprintf("earliest %d > commit upper %d", at.Earliest, w.CommitUpper())}
	}
	return ReadResult{Outcome: Pending, Write: w, At: at,
		Reason: fmt.Sprintf("earliest %d <= commit upper %d", at.Earliest, w.CommitUpper())}
}

// WaitEvidence records every interval observed while waiting for a write
// to become visible, so callers can audit why the wait resolved or why
// the read stayed pending.
type WaitEvidence struct {
	Key         string
	CommitUpper int64
	Observed    []Interval
	Ticks       int
	Outcome     Outcome
	Reason      string
}

func (e WaitEvidence) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "wait key=%q commitUpper=%d outcome=%s ticks=%d reason=%q",
		e.Key, e.CommitUpper, e.Outcome, e.Ticks, e.Reason)
	for i, iv := range e.Observed {
		fmt.Fprintf(&b, "\n  check %d: now=%s", i, iv)
	}
	return b.String()
}

// WaitVisible waits for key to become visible on clock c, advancing the
// clock one virtual tick at a time, at most maxTicks ticks. It returns
// pending if the clock interval stops making progress or the tick budget
// runs out. The evidence lists every interval checked.
func (s *Store) WaitVisible(c *Clock, key string, maxTicks int) (ReadResult, WaitEvidence) {
	ev := WaitEvidence{Key: key, Observed: []Interval{}}
	if w, ok := s.writes[key]; ok {
		ev.CommitUpper = w.CommitUpper()
	}
	for tick := 0; ; tick++ {
		now := c.Now()
		ev.Observed = append(ev.Observed, now)
		res := s.Read(key, now)
		if res.Outcome == Visible {
			ev.Outcome = Visible
			ev.Ticks = tick
			ev.Reason = res.Reason
			return res, ev
		}
		if tick == maxTicks {
			ev.Outcome = Pending
			ev.Ticks = tick
			ev.Reason = "tick budget exhausted: " + res.Reason
			res.Reason = ev.Reason
			return res, ev
		}
		if _, progressed := c.Tick(); !progressed {
			ev.Outcome = Pending
			ev.Ticks = tick + 1
			ev.Reason = fmt.Sprintf("clock %q interval made no progress at %s", c.Node(), c.Now())
			res.Outcome = Pending
			res.Reason = ev.Reason
			return res, ev
		}
	}
}

// ErrNoWrites is returned by verification helpers given no writes.
var ErrNoWrites = errors.New("clocksim: no committed writes")
