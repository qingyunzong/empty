package perm

import (
	"math"
	"math/rand"
	"reflect"
	"testing"
)

// checkAgainstStateModel verifies, for every tick in [lo, hi], that the
// interval timeline agrees with the per-tick state model, and that the
// timeline itself satisfies the half-open / boundary / merge invariants.
func checkAgainstStateModel(t *testing.T, s *Store, lo, hi int64) {
	t.Helper()
	ivs := s.Intervals()

	// Invariants: sorted, half-open, contiguous, maximally merged.
	for i, iv := range ivs {
		if iv.Start >= iv.End {
			t.Fatalf("interval %d not half-open: %v", i, iv)
		}
		if i > 0 {
			if ivs[i-1].End != iv.Start {
				t.Fatalf("intervals %d/%d not contiguous: %v then %v", i-1, i, ivs[i-1], iv)
			}
			if ivs[i-1].Decision.equal(iv.Decision) {
				t.Fatalf("adjacent intervals %d/%d should have merged: %v / %v",
					i-1, i, ivs[i-1], iv)
			}
		}
	}

	// Every tick: interval lookup == direct state model, and the tick lies
	// inside exactly the interval that covers it.
	for tick := lo; tick <= hi; tick++ {
		want := s.decide(tick)
		got := s.Query(tick)
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("tick %d: query=%+v, state model=%+v", tick, got, want)
		}
		idx := -1
		for i, iv := range ivs {
			if iv.Start <= tick && tick < iv.End {
				idx = i
				break
			}
		}
		if idx < 0 {
			t.Fatalf("tick %d not covered by any interval", tick)
		}
		if ivs[idx].Decision.Action != want.Action {
			t.Fatalf("tick %d: interval action %v, state model %v",
				tick, ivs[idx].Decision.Action, want.Action)
		}
		// Boundary: the interval must start exactly where its decision
		// first becomes true (or at the open lower bound).
		if ivs[idx].Start > lo && ivs[idx].Start != math.MinInt64 {
			prev := s.decide(ivs[idx].Start - 1)
			if prev.equal(ivs[idx].Decision) {
				t.Fatalf("interval %v starts late; decision already held at %d",
					ivs[idx], ivs[idx].Start-1)
			}
		}
	}
}

func TestDeterministicTimeline(t *testing.T) {
	events := []Event{
		{ID: "g1", Tick: 10, Version: 1, Kind: Grant},
		{ID: "r1", Tick: 20, Version: 1, Kind: Revoke},
		// Same tick as r1, higher version: grant wins at 20... but a
		// same-version revoke at 30 takes precedence over the grant.
		{ID: "g2", Tick: 20, Version: 2, Kind: Grant},
		{ID: "g3", Tick: 30, Version: 1, Kind: Grant},
		{ID: "r2", Tick: 30, Version: 1, Kind: Revoke}, // revoke priority at equal version
		// Temporary allow exception across the revoked span [40, 50).
		{ID: "x1", Tick: 40, Version: 1, Kind: Exception, Action: Allow, End: 50},
		// Overlapping deny exception inside it: revocation wins in [45, 48).
		{ID: "x2", Tick: 45, Version: 1, Kind: Exception, Action: Deny, End: 48},
	}
	s := NewStore(events)

	expect := map[int64]Action{}
	for tick := int64(5); tick < 60; tick++ {
		switch {
		case tick < 10:
			expect[tick] = Deny
		case tick < 20:
			expect[tick] = Allow // g1
		case tick < 30:
			expect[tick] = Allow // g2 (version 2 beats r1 version 1 at tick 20)
		case tick < 40:
			expect[tick] = Deny // r2 at 30 (revoke priority over g3)
		case tick < 45:
			expect[tick] = Allow // x1
		case tick < 48:
			expect[tick] = Deny // x2 overrides x1
		case tick < 50:
			expect[tick] = Allow // x1 again
		default:
			expect[tick] = Deny
		}
	}
	for tick, want := range expect {
		if got := s.Query(tick).Action; got != want {
			t.Errorf("tick %d: got %v, want %v", tick, got, want)
		}
	}

	// Adjacent merge check: [10,20) allow and [20,30) allow have different
	// chains (g1 vs g2), so they must NOT merge; [30,40) deny and the tail
	// after 50 differ by chain too. Verify exact boundaries.
	var bounds [][2]int64
	for _, iv := range s.Intervals() {
		bounds = append(bounds, [2]int64{iv.Start, iv.End})
	}
	wantBounds := [][2]int64{
		{math.MinInt64, 10}, {10, 20}, {20, 30}, {30, 40},
		{40, 45}, {45, 48}, {48, 50}, {50, Infinite},
	}
	if !reflect.DeepEqual(bounds, wantBounds) {
		t.Errorf("bounds=%v, want %v", bounds, wantBounds)
	}

	// Full chain at a tick governed by an overriding deny exception.
	d := s.Query(46)
	var reasons []string
	for _, st := range d.Chain {
		reasons = append(reasons, st.Reason)
	}
	wantReasons := []string{"default", "grant", "revoke", "grant", "grant", "revoke", "exception", "exception"}
	if !reflect.DeepEqual(reasons, wantReasons) {
		t.Errorf("chain reasons=%v, want %v", reasons, wantReasons)
	}
	if d.Action != Deny {
		t.Errorf("tick 46 action=%v, want deny", d.Action)
	}

	checkAgainstStateModel(t, s, 0, 70)
}

func TestCorrections(t *testing.T) {
	base := []Event{
		{ID: "g1", Tick: 10, Version: 1, Kind: Grant},
		{ID: "r1", Tick: 20, Version: 1, Kind: Revoke},
		{ID: "x1", Tick: 30, Version: 1, Kind: Exception, Action: Allow, End: 40},
	}
	before := NewStore(base)
	if got := before.Query(15).Action; got != Allow {
		t.Fatalf("before correction: tick 15 = %v, want allow", got)
	}

	// Correct history: g1 actually happened at 12, and x1 is retracted by
	// replacing it with a narrower window. r1 is corrected into a grant.
	corrected := append(append([]Event{}, base...),
		Event{ID: "g1fix", Tick: 12, Version: 1, Kind: Grant, Corrects: "g1"},
		Event{ID: "x1fix", Tick: 32, Version: 1, Kind: Exception, Action: Allow, End: 35, Corrects: "x1"},
		Event{ID: "r1fix", Tick: 20, Version: 1, Kind: Grant, Corrects: "r1"},
	)
	after := NewStore(corrected)

	for _, id := range []string{"g1", "r1", "x1"} {
		for _, e := range after.Events() {
			if e.ID == id {
				t.Fatalf("superseded event %q still active", id)
			}
		}
	}
	if got := after.Query(10).Action; got != Deny {
		t.Errorf("tick 10 = %v, want deny (grant moved to 12)", got)
	}
	if got := after.Query(25).Action; got != Allow {
		t.Errorf("tick 25 = %v, want allow (revoke corrected to grant)", got)
	}
	if got := after.Query(31).Action; got != Allow {
		t.Errorf("tick 31 = %v, want allow (old exception window gone)", got)
	}
	if got := after.Query(36).Action; got != Allow {
		t.Errorf("tick 36 = %v, want allow (narrowed exception ended)", got)
	}
	checkAgainstStateModel(t, after, 0, 60)

	// Chained correction: fix the fix.
	chained := append(append([]Event{}, corrected...),
		Event{ID: "g1fix2", Tick: 8, Version: 1, Kind: Grant, Corrects: "g1fix"},
	)
	s := NewStore(chained)
	if got := s.Query(9).Action; got != Allow {
		t.Errorf("tick 9 = %v, want allow after chained correction", got)
	}
	checkAgainstStateModel(t, s, 0, 60)
}

func TestRandomizedAgainstStateModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 200; trial++ {
		var events []Event
		n := 1 + rng.Intn(12)
		for i := 0; i < n; i++ {
			e := Event{
				ID:      string(rune('a'+i)) + string(rune('0'+trial%10)),
				Tick:    int64(rng.Intn(40)),
				Version: int64(rng.Intn(3)),
			}
			switch rng.Intn(3) {
			case 0:
				e.Kind = Grant
			case 1:
				e.Kind = Revoke
			default:
				e.Kind = Exception
				e.Action = Action(rng.Intn(2))
				e.End = e.Tick + 1 + int64(rng.Intn(10))
			}
			events = append(events, e)
		}
		// Randomly correct some historical events.
		for i := 0; i < len(events); i++ {
			if rng.Intn(4) == 0 {
				fix := events[i]
				fix.ID = fix.ID + "fix"
				fix.Tick = int64(rng.Intn(40))
				fix.Corrects = events[i].ID
				events = append(events, fix)
			}
		}
		s := NewStore(events)
		checkAgainstStateModel(t, s, -2, 55)
	}
}
