package perm

import (
	"reflect"
	"testing"
)

func mustAppend(l *Ledger, e Event) int64 { return l.Append(e) }

func TestGrantRevokeIntervals(t *testing.T) {
	l := NewLedger()
	mustAppend(l, Event{Tick: 5, Version: 1, Action: "read", Kind: Grant})
	mustAppend(l, Event{Tick: 10, Version: 1, Action: "read", Kind: Revoke})

	got := l.Intervals("read")
	want := []Interval{{Start: 5, End: 10}}
	if len(got) != 1 || got[0].Start != want[0].Start || got[0].End != want[0].End {
		t.Fatalf("intervals = %+v, want %+v", got, want)
	}
	// Half-open boundaries: denied at 4 and 10, allowed at 5 and 9.
	for tick, want := range map[int64]bool{4: false, 5: true, 9: true, 10: false} {
		if d := l.Query("read", tick); d.Allowed != want {
			t.Errorf("Query(read,%d).Allowed = %v, want %v", tick, d.Allowed, want)
		}
	}
}

func TestSameTickVersionOrder(t *testing.T) {
	// Revoke v1 then Grant v2 at the same tick: the later version wins.
	l := NewLedger()
	mustAppend(l, Event{Tick: 5, Version: 1, Action: "a", Kind: Revoke})
	mustAppend(l, Event{Tick: 5, Version: 2, Action: "a", Kind: Grant})
	if d := l.Query("a", 5); !d.Allowed {
		t.Errorf("grant with higher version should win, got denied")
	}

	// Grant v1 then Revoke v2: denied from tick 5 on.
	l2 := NewLedger()
	mustAppend(l2, Event{Tick: 5, Version: 1, Action: "a", Kind: Grant})
	mustAppend(l2, Event{Tick: 5, Version: 2, Action: "a", Kind: Revoke})
	if d := l2.Query("a", 5); d.Allowed {
		t.Errorf("revoke with higher version should win, got allowed")
	}
}

func TestSameTickSameVersionRevokePriority(t *testing.T) {
	l := NewLedger()
	mustAppend(l, Event{Tick: 5, Version: 1, Action: "a", Kind: Grant})
	mustAppend(l, Event{Tick: 5, Version: 1, Action: "a", Kind: Revoke})
	if d := l.Query("a", 5); d.Allowed {
		t.Errorf("revoke must take priority on (tick, version) tie, got allowed")
	}
	if got := l.Intervals("a"); len(got) != 0 {
		t.Errorf("intervals = %+v, want none", got)
	}
}

func TestExceptionWindows(t *testing.T) {
	// Deny exception cuts a hole into a granted period.
	l := NewLedger()
	mustAppend(l, Event{Tick: 0, Version: 1, Action: "a", Kind: Grant})
	mustAppend(l, Event{Tick: 3, Version: 1, Action: "a", Kind: Exception, Effect: Deny, Until: 6})
	got := l.Intervals("a")
	if len(got) != 2 || got[0].Start != 0 || got[0].End != 3 || got[1].Start != 6 || got[1].End != Inf {
		t.Fatalf("intervals = %+v, want [0,3) and [6,Inf)", got)
	}
	for tick, want := range map[int64]bool{2: true, 3: false, 5: false, 6: true} {
		if d := l.Query("a", tick); d.Allowed != want {
			t.Errorf("Query(a,%d).Allowed = %v, want %v", tick, d.Allowed, want)
		}
	}

	// Allow exception opens a window inside a revoked period.
	l2 := NewLedger()
	mustAppend(l2, Event{Tick: 0, Version: 1, Action: "a", Kind: Grant})
	mustAppend(l2, Event{Tick: 2, Version: 1, Action: "a", Kind: Revoke})
	mustAppend(l2, Event{Tick: 5, Version: 1, Action: "a", Kind: Exception, Effect: Allow, Until: 8})
	got2 := l2.Intervals("a")
	if len(got2) != 2 || got2[0].Start != 0 || got2[0].End != 2 || got2[1].Start != 5 || got2[1].End != 8 {
		t.Fatalf("intervals = %+v, want [0,2) and [5,8)", got2)
	}
}

func TestDenyExceptionPriority(t *testing.T) {
	// Overlapping allow and deny exceptions: deny wins (revoke priority).
	l := NewLedger()
	mustAppend(l, Event{Tick: 0, Version: 1, Action: "a", Kind: Grant})
	mustAppend(l, Event{Tick: 2, Version: 1, Action: "a", Kind: Exception, Effect: Allow, Until: 9})
	mustAppend(l, Event{Tick: 4, Version: 1, Action: "a", Kind: Exception, Effect: Deny, Until: 6})
	for tick, want := range map[int64]bool{3: true, 4: false, 5: false, 6: true} {
		if d := l.Query("a", tick); d.Allowed != want {
			t.Errorf("Query(a,%d).Allowed = %v, want %v", tick, d.Allowed, want)
		}
	}
}

func TestQueryReturnsFullChain(t *testing.T) {
	l := NewLedger()
	g := mustAppend(l, Event{Tick: 0, Version: 1, Action: "a", Kind: Grant})
	x := mustAppend(l, Event{Tick: 3, Version: 1, Action: "a", Kind: Exception, Effect: Deny, Until: 6})

	d := l.Query("a", 4)
	if d.Allowed {
		t.Fatalf("expected denied inside deny exception")
	}
	var ids []int64
	for _, e := range d.Chain {
		ids = append(ids, e.ID)
	}
	if !reflect.DeepEqual(ids, []int64{g, x}) {
		t.Fatalf("chain IDs = %v, want [%d %d]", ids, g, x)
	}

	// Outside any event: empty chain, denied.
	if d := l.Query("a", -1); d.Allowed || len(d.Chain) != 0 {
		t.Errorf("Query before any event = %+v, want denied with empty chain", d)
	}
}

func TestCorrectHistory(t *testing.T) {
	l := NewLedger()
	mustAppend(l, Event{Tick: 5, Version: 1, Action: "a", Kind: Grant})
	r := mustAppend(l, Event{Tick: 10, Version: 1, Action: "a", Kind: Revoke})

	if got := l.Intervals("a"); len(got) != 1 || got[0].Start != 5 || got[0].End != 10 {
		t.Fatalf("before correction: %+v, want [5,10)", got)
	}

	// Move the revocation earlier; bump its version.
	if err := l.Correct(r, Event{Tick: 8, Version: 2, Action: "a", Kind: Revoke}); err != nil {
		t.Fatal(err)
	}
	got := l.Intervals("a")
	if len(got) != 1 || got[0].Start != 5 || got[0].End != 8 {
		t.Fatalf("after correction: %+v, want [5,8)", got)
	}

	// Turn the revocation into a grant: the action stays effective forever.
	if err := l.Correct(r, Event{Tick: 8, Version: 3, Action: "a", Kind: Grant}); err != nil {
		t.Fatal(err)
	}
	got = l.Intervals("a")
	if len(got) != 1 || got[0].Start != 5 || got[0].End != Inf {
		t.Fatalf("after kind correction: %+v, want [5,Inf)", got)
	}

	if err := l.Correct(999, Event{Tick: 1, Action: "a", Kind: Grant}); err != ErrUnknownEvent {
		t.Errorf("Correct(unknown) err = %v, want ErrUnknownEvent", err)
	}
}

func TestAdjacentMerge(t *testing.T) {
	// Two consecutive grants with no state change must merge into one
	// segment; a re-grant after a revoke must not merge across the revoke.
	l := NewLedger()
	g1 := mustAppend(l, Event{Tick: 0, Version: 1, Action: "a", Kind: Grant})
	mustAppend(l, Event{Tick: 4, Version: 1, Action: "a", Kind: Grant})
	segs := l.Segments("a")
	if len(segs) != 1 || segs[0].Start != 0 || segs[0].End != Inf {
		t.Fatalf("segments = %+v, want single [0,Inf)", segs)
	}
	// The chain keeps the earliest determining grant.
	if len(segs[0].Decision.Chain) != 1 || segs[0].Decision.Chain[0].ID != g1 {
		t.Fatalf("chain = %+v, want [grant#%d]", segs[0].Decision.Chain, g1)
	}

	mustAppend(l, Event{Tick: 8, Version: 1, Action: "a", Kind: Revoke})
	mustAppend(l, Event{Tick: 12, Version: 1, Action: "a", Kind: Grant})
	segs = l.Segments("a")
	if len(segs) != 3 {
		t.Fatalf("segments = %+v, want 3 segments", segs)
	}
	if segs[0].End != 8 || segs[1].Start != 8 || segs[1].End != 12 || segs[2].Start != 12 {
		t.Fatalf("segment boundaries wrong: %+v", segs)
	}
	if segs[1].Decision.Allowed {
		t.Errorf("middle segment must be denied")
	}
}
