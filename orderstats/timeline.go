package orderstats

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"time"
)

// Interval is a half-open residence span [Start, End) of an order in a
// state. A zero End means the order is still in the state (open-ended).
type Interval struct {
	State State
	Start time.Time
	End   time.Time
}

// view is the derived result of applying a sequence of events.
type view struct {
	states     map[string]State
	intervals  map[string][]Interval
	rejections []Rejection
}

func newView() *view {
	return &view{
		states:    make(map[string]State),
		intervals: make(map[string][]Interval),
	}
}

// apply folds one event into the view. Illegal transitions are recorded as
// rejections with the event as evidence and do not take effect.
func (v *view) apply(ev Event) {
	cur := v.states[ev.OrderID]
	if !Legal(cur, ev.To) {
		v.rejections = append(v.rejections, Rejection{
			Event:   ev,
			Current: cur,
			Reason:  fmt.Sprintf("illegal transition %q -> %q", cur, ev.To),
		})
		return
	}
	ivs := v.intervals[ev.OrderID]
	if n := len(ivs); n > 0 && ivs[n-1].End.IsZero() {
		ivs[n-1].End = ev.Timestamp
	}
	v.intervals[ev.OrderID] = append(ivs, Interval{State: ev.To, Start: ev.Timestamp})
	v.states[ev.OrderID] = ev.To
}

// less orders events by (Timestamp, Version, ID).
func less(a, b Event) bool {
	if !a.Timestamp.Equal(b.Timestamp) {
		return a.Timestamp.Before(b.Timestamp)
	}
	if a.Version != b.Version {
		return a.Version < b.Version
	}
	return a.ID < b.ID
}

// Timeline accumulates order events and derives per-order state timelines.
// The zero value is ready to use.
type Timeline struct {
	byID       map[string]Event // effective event per event ID (highest version)
	seen       map[string]int   // event ID -> highest version ever added
	incr       *view            // incrementally maintained view
	duplicates []Rejection      // evidence for duplicate (ID, Version) events
}

// ErrInconsistent is returned when the incremental result disagrees with a
// full replay; it indicates a bug in the incremental path.
var ErrInconsistent = errors.New("orderstats: incremental result differs from full replay")

// Add folds an event into the timeline.
//
// A event whose ID was already seen with the same Version is a duplicate: it
// is recorded as evidence and ignored. An event whose ID was seen with a
// lower Version is a correction: it supersedes the earlier event, which may
// change the legality of subsequent events, so the timeline is rebuilt by
// full replay. Otherwise the event is applied incrementally and the result
// is verified against a full replay.
func (t *Timeline) Add(ev Event) error {
	if t.byID == nil {
		t.byID = make(map[string]Event)
		t.seen = make(map[string]int)
		t.incr = newView()
	}
	if v, ok := t.seen[ev.ID]; ok {
		switch {
		case ev.Version == v:
			t.duplicates = append(t.duplicates, Rejection{
				Event:   ev,
				Current: t.incr.states[ev.OrderID],
				Reason:  "duplicate event",
			})
			return nil
		case ev.Version < v:
			t.duplicates = append(t.duplicates, Rejection{
				Event:   ev,
				Current: t.incr.states[ev.OrderID],
				Reason:  "superseded version",
			})
			return nil
		}
		// Correction: supersedes the earlier event. Successor legality may
		// change, so rebuild from scratch.
		t.seen[ev.ID] = ev.Version
		t.byID[ev.ID] = ev
		t.incr = t.replay()
		return nil
	}
	t.seen[ev.ID] = ev.Version
	t.byID[ev.ID] = ev

	// Incremental fast path is only valid if the event sorts after every
	// effective event already applied.
	fastPath := true
	if last, ok := t.lastEvent(); ok && less(ev, last) {
		fastPath = false
	}
	if fastPath {
		t.incr.apply(ev)
	} else {
		t.incr = t.replay()
	}

	// Full replay verifies every increment.
	if check := t.replay(); !reflect.DeepEqual(t.incr, check) {
		return fmt.Errorf("%w after event %s v%d", ErrInconsistent, ev.ID, ev.Version)
	}
	return nil
}

// replay rebuilds the derived view from all effective events in order.
func (t *Timeline) replay() *view {
	v := newView()
	for _, ev := range t.effective() {
		v.apply(ev)
	}
	return v
}

// effective returns the effective events sorted by (Timestamp, Version, ID).
func (t *Timeline) effective() []Event {
	evs := make([]Event, 0, len(t.byID))
	for _, ev := range t.byID {
		evs = append(evs, ev)
	}
	sort.Slice(evs, func(i, j int) bool { return less(evs[i], evs[j]) })
	return evs
}

func (t *Timeline) lastEvent() (Event, bool) {
	evs := t.effective()
	if len(evs) == 0 {
		return Event{}, false
	}
	return evs[len(evs)-1], true
}

// State returns the current state of an order, or StateNone if unknown.
func (t *Timeline) State(orderID string) State {
	if t.incr == nil {
		return StateNone
	}
	return t.incr.states[orderID]
}

// Intervals returns the half-open residence intervals of an order in
// chronological order.
func (t *Timeline) Intervals(orderID string) []Interval {
	if t.incr == nil {
		return nil
	}
	return append([]Interval(nil), t.incr.intervals[orderID]...)
}

// Rejections returns the evidence for events that attempted illegal
// transitions and did not take effect.
func (t *Timeline) Rejections() []Rejection {
	if t.incr == nil {
		return nil
	}
	return append([]Rejection(nil), t.incr.rejections...)
}

// Duplicates returns the evidence for events ignored because their
// (ID, Version) pair was already seen or superseded by a correction.
func (t *Timeline) Duplicates() []Rejection {
	return append([]Rejection(nil), t.duplicates...)
}

// Events returns the effective events in application order.
func (t *Timeline) Events() []Event {
	if t.byID == nil {
		return nil
	}
	return t.effective()
}
