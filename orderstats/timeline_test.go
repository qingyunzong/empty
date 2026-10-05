package orderstats

import (
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(hours int) time.Time { return t0.Add(time.Duration(hours) * time.Hour) }

func ev(id, order string, version, hours int, to State) Event {
	return Event{ID: id, OrderID: order, Version: version, Timestamp: at(hours), To: to}
}

func TestSameTimestampOrderedByVersionThenID(t *testing.T) {
	var tl Timeline
	// Same timestamp: version decides. paid(v2) must apply after created(v1).
	mustAdd(t, &tl, ev("e-paid", "o1", 2, 0, StatePaid))
	mustAdd(t, &tl, ev("e-created", "o1", 1, 0, StateCreated))
	if got := tl.State("o1"); got != StatePaid {
		t.Fatalf("state = %q, want %q", got, StatePaid)
	}
	if n := len(tl.Rejections()); n != 0 {
		t.Fatalf("rejections = %d, want 0", n)
	}

	// Same timestamp and version: ID decides. "a-paid" sorts before
	// "z-created", so paid is attempted from StateNone and rejected.
	var tl2 Timeline
	mustAdd(t, &tl2, ev("z-created", "o2", 1, 0, StateCreated))
	mustAdd(t, &tl2, ev("a-paid", "o2", 1, 0, StatePaid))
	if got := tl2.State("o2"); got != StateCreated {
		t.Fatalf("state = %q, want %q", got, StateCreated)
	}
	rej := tl2.Rejections()
	if len(rej) != 1 || rej[0].Event.ID != "a-paid" {
		t.Fatalf("rejections = %+v, want one for a-paid", rej)
	}
}

func TestIllegalTransitionRejectedWithEvidence(t *testing.T) {
	var tl Timeline
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated))
	mustAdd(t, &tl, ev("e2", "o1", 1, 1, StateShipped)) // created -> shipped is illegal

	if got := tl.State("o1"); got != StateCreated {
		t.Fatalf("state = %q, want %q (illegal transition must not take effect)", got, StateCreated)
	}
	rej := tl.Rejections()
	if len(rej) != 1 {
		t.Fatalf("rejections = %d, want 1", len(rej))
	}
	r := rej[0]
	if r.Event.ID != "e2" || r.Event.To != StateShipped {
		t.Fatalf("rejection event = %+v, want evidence of e2", r.Event)
	}
	if r.Current != StateCreated {
		t.Fatalf("rejection current = %q, want %q", r.Current, StateCreated)
	}
	if !strings.Contains(r.Reason, "illegal transition") {
		t.Fatalf("reason = %q, want illegal transition", r.Reason)
	}

	// The order can still proceed legally afterwards.
	mustAdd(t, &tl, ev("e3", "o1", 1, 2, StatePaid))
	if got := tl.State("o1"); got != StatePaid {
		t.Fatalf("state = %q, want %q", got, StatePaid)
	}
}

func TestCorrectionChangesSuccessorLegality(t *testing.T) {
	var tl Timeline
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated))
	mustAdd(t, &tl, ev("e2", "o1", 1, 1, StatePaid))
	mustAdd(t, &tl, ev("e3", "o1", 1, 2, StateShipped))
	if got := tl.State("o1"); got != StateShipped {
		t.Fatalf("state = %q, want %q", got, StateShipped)
	}

	// Correction: e2 becomes cancelled. The previously legal e3
	// (paid -> shipped) is now illegal (cancelled is terminal).
	mustAdd(t, &tl, ev("e2", "o1", 2, 1, StateCancelled))
	if got := tl.State("o1"); got != StateCancelled {
		t.Fatalf("state = %q, want %q", got, StateCancelled)
	}
	rej := tl.Rejections()
	if len(rej) != 1 || rej[0].Event.ID != "e3" {
		t.Fatalf("rejections = %+v, want one for e3", rej)
	}
	if rej[0].Current != StateCancelled {
		t.Fatalf("rejection current = %q, want %q", rej[0].Current, StateCancelled)
	}
}

func TestLateEventChangesSuccessorLegality(t *testing.T) {
	var tl Timeline
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated))
	mustAdd(t, &tl, ev("e3", "o1", 1, 2, StateShipped)) // illegal from created
	if n := len(tl.Rejections()); n != 1 {
		t.Fatalf("rejections = %d, want 1", n)
	}
	// A paid event arriving late (out of order) makes e3 legal on replay.
	mustAdd(t, &tl, ev("e2", "o1", 1, 1, StatePaid))
	if got := tl.State("o1"); got != StateShipped {
		t.Fatalf("state = %q, want %q", got, StateShipped)
	}
	if n := len(tl.Rejections()); n != 0 {
		t.Fatalf("rejections = %d, want 0 after replay", n)
	}
}

func TestDuplicateAndSupersededEvidence(t *testing.T) {
	var tl Timeline
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated))
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated)) // exact duplicate
	mustAdd(t, &tl, ev("e1", "o1", 2, 0, StateCreated)) // correction
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated)) // superseded version

	dups := tl.Duplicates()
	if len(dups) != 2 {
		t.Fatalf("duplicates = %+v, want 2", dups)
	}
	if dups[0].Reason != "duplicate event" {
		t.Fatalf("reason = %q, want duplicate event", dups[0].Reason)
	}
	if dups[1].Reason != "superseded version" {
		t.Fatalf("reason = %q, want superseded version", dups[1].Reason)
	}
	if got := tl.State("o1"); got != StateCreated {
		t.Fatalf("state = %q, want %q", got, StateCreated)
	}
	if n := len(tl.Events()); n != 1 {
		t.Fatalf("effective events = %d, want 1", n)
	}
}

// TestReplayVerifiesEveryIncrement feeds a mixed sequence — multiple orders,
// out-of-order arrivals, corrections, duplicates and illegal transitions —
// and requires every increment to be verified against a full replay.
func TestReplayVerifiesEveryIncrement(t *testing.T) {
	var tl Timeline
	seq := []Event{
		ev("a1", "o1", 1, 0, StateCreated),
		ev("b1", "o2", 1, 0, StateCreated),
		ev("a2", "o1", 1, 1, StatePaid),
		ev("b2", "o2", 1, 1, StateCancelled),
		ev("a3", "o1", 1, 2, StateShipped),
		ev("a4", "o1", 1, 3, StateDelivered),
		ev("a5", "o1", 1, 4, StateCancelled), // illegal: delivered is terminal
		ev("b3", "o2", 1, 2, StateShipped),   // illegal: cancelled is terminal
		ev("a2", "o1", 2, 1, StateCancelled), // correction: o1 becomes cancelled
		ev("a2", "o1", 3, 1, StatePaid),      // correction back: successors legal again
		ev("b1", "o2", 1, 0, StateCreated),   // duplicate
		ev("c1", "o3", 1, 5, StateCreated),   // late arrival, sorts last
		ev("c0", "o3", 1, 0, StateCancelled), // illegal first event, out of order
	}
	for i, e := range seq {
		if err := tl.Add(e); err != nil {
			t.Fatalf("Add #%d (%+v): %v", i, e, err)
		}
	}

	if got := tl.State("o1"); got != StateDelivered {
		t.Fatalf("o1 state = %q, want %q", got, StateDelivered)
	}
	if got := tl.State("o2"); got != StateCancelled {
		t.Fatalf("o2 state = %q, want %q", got, StateCancelled)
	}
	if got := tl.State("o3"); got != StateCreated {
		t.Fatalf("o3 state = %q, want %q", got, StateCreated)
	}

	rej := tl.Rejections()
	if len(rej) != 3 {
		t.Fatalf("rejections = %+v, want 3", rej)
	}
	wantCurrent := map[string]State{"a5": StateDelivered, "b3": StateCancelled, "c0": StateNone}
	for _, r := range rej {
		want, ok := wantCurrent[r.Event.ID]
		if !ok {
			t.Fatalf("unexpected rejection of %s", r.Event.ID)
		}
		if r.Current != want {
			t.Fatalf("rejection of %s: current = %q, want %q", r.Event.ID, r.Current, want)
		}
		delete(wantCurrent, r.Event.ID)
	}
	if len(wantCurrent) != 0 {
		t.Fatalf("missing rejections for %v", wantCurrent)
	}
	if n := len(tl.Duplicates()); n != 1 {
		t.Fatalf("duplicates = %d, want 1", n)
	}
}

func mustAdd(t *testing.T, tl *Timeline, e Event) {
	t.Helper()
	if err := tl.Add(e); err != nil {
		t.Fatalf("Add(%+v): %v", e, err)
	}
}
