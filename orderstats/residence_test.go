package orderstats

import (
	"testing"
	"time"
)

// buildTimeline creates o1 with:
//
//	created [t0,t2)  paid [t2,t5)  shipped [t5,t9)  delivered [t9, open)
//
// plus a rejected event that must not contribute any residence.
func buildTimeline(t *testing.T) *Timeline {
	t.Helper()
	var tl Timeline
	mustAdd(t, &tl, ev("e1", "o1", 1, 0, StateCreated))
	mustAdd(t, &tl, ev("e2", "o1", 1, 2, StatePaid))
	mustAdd(t, &tl, ev("eX", "o1", 1, 3, StateDelivered)) // illegal from paid
	mustAdd(t, &tl, ev("e3", "o1", 1, 5, StateShipped))
	mustAdd(t, &tl, ev("e4", "o1", 1, 9, StateDelivered))
	return &tl
}

func TestResidenceHalfOpenRange(t *testing.T) {
	tl := buildTimeline(t)

	// Exact state span: [t0, t2) is entirely created.
	got := tl.Residence("o1", at(0), at(2))
	if got[StateCreated] != 2*time.Hour || len(got) != 1 {
		t.Fatalf("residence = %v, want created=2h only", got)
	}

	// The instant t2 belongs to paid, not created (half-open intervals).
	got = tl.Residence("o1", at(2), at(5))
	if got[StatePaid] != 3*time.Hour || len(got) != 1 {
		t.Fatalf("residence = %v, want paid=3h only", got)
	}

	// A range crossing a boundary splits the residence.
	got = tl.Residence("o1", at(1), at(3))
	if got[StateCreated] != time.Hour || got[StatePaid] != time.Hour || len(got) != 2 {
		t.Fatalf("residence = %v, want created=1h paid=1h", got)
	}

	// Empty range yields nothing.
	if got := tl.Residence("o1", at(2), at(2)); len(got) != 0 {
		t.Fatalf("residence = %v, want empty", got)
	}

	// Open-ended interval is clipped by the query end.
	got = tl.Residence("o1", at(9), at(19))
	if got[StateDelivered] != 10*time.Hour || len(got) != 1 {
		t.Fatalf("residence = %v, want delivered=10h only", got)
	}

	// The rejected eX left no interval behind.
	ivs := tl.Intervals("o1")
	if len(ivs) != 4 {
		t.Fatalf("intervals = %+v, want 4", ivs)
	}
	for _, iv := range ivs {
		if iv.State == StateDelivered && iv.Start == at(3) {
			t.Fatalf("rejected event produced interval %+v", iv)
		}
	}
}

func TestTotalResidence(t *testing.T) {
	tl := buildTimeline(t)
	mustAdd(t, tl, ev("f1", "o2", 1, 1, StateCreated))
	mustAdd(t, tl, ev("f2", "o2", 1, 4, StatePaid))

	got := tl.TotalResidence(at(0), at(5))
	want := map[State]time.Duration{
		StateCreated: 2*time.Hour + 3*time.Hour, // o1 [t0,t2) + o2 [t1,t4)
		StatePaid:    3*time.Hour + time.Hour,   // o1 [t2,t5) + o2 [t4,t5)
	}
	if len(got) != len(want) {
		t.Fatalf("total residence = %v, want %v", got, want)
	}
	for s, d := range want {
		if got[s] != d {
			t.Fatalf("total residence[%s] = %v, want %v", s, got[s], d)
		}
	}
}
