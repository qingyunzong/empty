package perm

import (
	"math/rand"
	"sort"
	"testing"
)

// tickModel is an independent, incremental per-tick state machine used to
// cross-check the interval model. It walks tick by tick, applies the events
// scheduled at each tick in (version, revoke-priority) order, expires
// exception windows, and records the effective state.
func tickModel(events []Event, from, to int64) map[int64]bool {
	byTick := map[int64][]Event{}
	for _, e := range events {
		if e.Kind == Exception && e.Until <= e.Tick {
			continue
		}
		byTick[e.Tick] = append(byTick[e.Tick], e)
	}
	for _, list := range byTick {
		sort.Slice(list, func(i, j int) bool { return lessEvent(list[i], list[j]) })
	}

	allowed := false
	var active []Event // active exceptions
	out := map[int64]bool{}
	for t := from; t < to; t++ {
		kept := active[:0]
		for _, ex := range active {
			if ex.Until > t {
				kept = append(kept, ex)
			}
		}
		active = kept
		for _, e := range byTick[t] {
			switch e.Kind {
			case Grant:
				allowed = true
			case Revoke:
				allowed = false
			case Exception:
				active = append(active, e)
			}
		}
		eff := allowed
		deny, allow := false, false
		for _, ex := range active {
			if ex.Effect == Deny {
				deny = true
			} else {
				allow = true
			}
		}
		if deny {
			eff = false
		} else if allow {
			eff = true
		}
		out[t] = eff
	}
	return out
}

func randomEvents(r *rand.Rand, actions []string, n int, maxTick int64) []Event {
	var evts []Event
	for i := 0; i < n; i++ {
		e := Event{
			Tick:    r.Int63n(maxTick),
			Version: r.Int63n(3),
			Action:  actions[r.Intn(len(actions))],
		}
		switch r.Intn(4) {
		case 0, 1:
			e.Kind = Grant
		case 2:
			e.Kind = Revoke
		default:
			e.Kind = Exception
			if r.Intn(2) == 0 {
				e.Effect = Allow
			} else {
				e.Effect = Deny
			}
			e.Until = e.Tick + 1 + r.Int63n(10)
		}
		evts = append(evts, e)
	}
	return evts
}

func checkSegmentsAgainstTickModel(t *testing.T, l *Ledger, action string, from, to int64) {
	t.Helper()
	segs := l.Segments(action)
	model := tickModel(l.Events(action), from, to)

	// Structural invariants: sorted, half-open, contiguous, open-ended tail,
	// and no adjacent segments with equal decision+chain (merge check).
	for i, s := range segs {
		if s.Start >= s.End {
			t.Fatalf("action %s: segment %d not half-open positive: %+v", action, i, s)
		}
		if i+1 < len(segs) && s.End != segs[i+1].Start {
			t.Fatalf("action %s: segments %d/%d not contiguous: %+v", action, i, i+1, segs)
		}
		if i+1 < len(segs) && chainKey(s.Decision) == chainKey(segs[i+1].Decision) {
			t.Fatalf("action %s: segments %d/%d should have been merged: %+v", action, i, i+1, segs)
		}
	}
	if n := len(segs); n > 0 && segs[n-1].End != Inf {
		t.Fatalf("action %s: last segment must be open-ended: %+v", action, segs[n-1])
	}

	// Boundary check: every segment start is exactly where the per-tick
	// model changes decision or chain.
	segAt := func(tick int64) *Segment {
		for i := range segs {
			if segs[i].Start <= tick && tick < segs[i].End {
				return &segs[i]
			}
		}
		return nil
	}
	for tick := from; tick < to; tick++ {
		s := segAt(tick)
		var got bool
		if s != nil {
			got = s.Decision.Allowed
		}
		if want := model[tick]; got != want {
			t.Fatalf("action %s tick %d: interval model = %v, tick model = %v (segs=%+v)",
				action, tick, got, want, segs)
		}
		if s != nil && tick == s.Start && tick != segs[0].Start {
			prev := l.Query(action, tick-1)
			if chainKey(prev) == chainKey(s.Decision) {
				t.Fatalf("action %s: segment boundary at %d without a change: %+v", action, tick, segs)
			}
		}
	}
}

func TestIntervalModelMatchesTickModel(t *testing.T) {
	actions := []string{"read", "write", "exec"}
	for seed := int64(0); seed < 30; seed++ {
		r := rand.New(rand.NewSource(seed))
		l := NewLedger()
		for _, e := range randomEvents(r, actions, 60, 50) {
			l.Append(e)
		}
		// Correct a few historical events, bumping their versions.
		for id := int64(1); id <= 5; id++ {
			e := randomEvents(r, actions, 1, 50)[0]
			e.Version += 10
			if err := l.Correct(id, e); err != nil {
				t.Fatalf("seed %d: correct: %v", seed, err)
			}
		}
		for _, action := range actions {
			checkSegmentsAgainstTickModel(t, l, action, -2, 70)
		}
	}
}

func TestBoundariesAfterCorrection(t *testing.T) {
	l := NewLedger()
	g := l.Append(Event{Tick: 10, Version: 1, Action: "a", Kind: Grant})
	l.Append(Event{Tick: 20, Version: 1, Action: "a", Kind: Revoke})
	l.Append(Event{Tick: 15, Version: 1, Action: "a", Kind: Exception, Effect: Allow, Until: 25})

	// Correct the grant to a later tick: the exception window [15,25) now
	// overlaps a denied base, so [15,25) becomes effective.
	if err := l.Correct(g, Event{Tick: 30, Version: 2, Action: "a", Kind: Grant}); err != nil {
		t.Fatal(err)
	}
	got := l.Intervals("a")
	if len(got) != 2 || got[0].Start != 15 || got[0].End != 25 || got[1].Start != 30 || got[1].End != Inf {
		t.Fatalf("intervals after correction = %+v, want [15,25) and [30,Inf)", got)
	}
	checkSegmentsAgainstTickModel(t, l, "a", 0, 40)
}
