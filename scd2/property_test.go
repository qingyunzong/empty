package scd2

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
	"time"
)

// modelAt is the reference model: the state at t is decided by the event
// with the greatest effective time not after t. Event times are distinct,
// so there are no ties.
func modelAt(evs []Event[string], key string, t time.Time) (string, bool) {
	best := -1
	for i, ev := range evs {
		if ev.Key != key || ev.At.After(t) {
			continue
		}
		if best < 0 || ev.At.After(evs[best].At) {
			best = i
		}
	}
	if best < 0 || evs[best].Kind == EventDelete {
		return "", false
	}
	return evs[best].Attrs, true
}

// TestPointInTimeAgainstModel applies a random out-of-order event stream
// and cross-checks AsOf point-in-time queries against the reference model,
// while asserting the structural invariants after every event.
func TestPointInTimeAgainstModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261114))
	keys := []string{"k1", "k2", "k3"}
	attrs := []string{"A", "B", "C"}
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	for trial := 0; trial < 30; trial++ {
		s := New[string]()
		var evs []Event[string]
		used := map[int64]bool{}

		for i := 0; i < 200; i++ {
			// Distinct effective times keep the reference model unambiguous.
			var off int64
			for {
				off = int64(rng.Intn(400))
				if !used[off] {
					used[off] = true
					break
				}
			}
			ev := Event[string]{
				Key: keys[rng.Intn(len(keys))],
				At:  base.Add(time.Duration(off) * time.Hour),
			}
			if rng.Intn(4) == 0 {
				ev.Kind = EventDelete
			} else {
				ev.Kind = EventUpsert
				ev.Attrs = attrs[rng.Intn(len(attrs))]
			}
			evs = append(evs, ev)
			s.Apply(ev)

			if err := s.Validate(); err != nil {
				t.Fatalf("trial %d event %d (%+v): %v", trial, i, ev, err)
			}
		}

		// Point-in-time verification across the full timeline, per key.
		for _, key := range keys {
			for h := int64(-1); h <= 401; h++ {
				at := base.Add(time.Duration(h) * time.Hour)
				wantAttrs, wantOK := modelAt(evs, key, at)
				iv, ok := s.AsOf(key, at)
				if ok != wantOK || (ok && iv.Attrs != wantAttrs) {
					t.Fatalf("trial %d: AsOf(%s, %s) = (%v, %v), want (%q, %v)",
						trial, key, at, iv, ok, wantAttrs, wantOK)
				}
			}
			// Current flag uniqueness: at most one open interval, and it
			// must agree with the model at the far future.
			ivs := s.Intervals(key)
			open := 0
			for _, iv := range ivs {
				if iv.IsCurrent() {
					open++
				}
			}
			if open > 1 {
				t.Fatalf("trial %d: %s has %d current intervals", trial, key, open)
			}
			_, wantOK := modelAt(evs, key, base.Add(10000*time.Hour))
			if _, ok := s.Current(key); ok != wantOK {
				t.Fatalf("trial %d: Current(%s) ok=%v, want %v", trial, key, ok, wantOK)
			}
		}
	}
}

// TestArrivalOrderIndependence applies the same event set in shuffled
// orders and requires identical final interval lists.
func TestArrivalOrderIndependence(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	base := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)

	var evs []Event[string]
	for i := 0; i < 60; i++ {
		ev := Event[string]{
			Key: fmt.Sprintf("k%d", i%4),
			At:  base.Add(time.Duration(i) * time.Hour),
		}
		if i%5 == 4 {
			ev.Kind = EventDelete
		} else {
			ev.Kind = EventUpsert
			ev.Attrs = string(rune('A' + i%3))
		}
		evs = append(evs, ev)
	}

	snapshot := func(s *Store[string]) string {
		var keys []string
		for _, k := range []string{"k0", "k1", "k2", "k3"} {
			if len(s.Intervals(k)) > 0 {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		out := ""
		for _, k := range keys {
			out += fmt.Sprintln(s.Intervals(k))
		}
		return out
	}

	ordered := New[string]()
	ordered.ApplyAll(evs)
	want := snapshot(ordered)

	for trial := 0; trial < 20; trial++ {
		shuffled := make([]Event[string], len(evs))
		copy(shuffled, evs)
		rng.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
		s := New[string]()
		s.ApplyAll(shuffled)
		if got := snapshot(s); got != want {
			t.Fatalf("trial %d: final state differs under shuffled arrival\nwant:\n%s\ngot:\n%s", trial, want, got)
		}
	}
}
