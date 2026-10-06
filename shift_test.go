package occupancy

import (
	"math/rand"
	"testing"
)

func TestEarliestShiftHandComputed(t *testing.T) {
	p := New()
	mustAdd(t, p, "blocker", []Reservation{{Track: 0, Start: 5, End: 15}})
	mustAdd(t, p, "blocker2", []Reservation{{Track: 0, Start: 20, End: 25}})
	mustAdd(t, p, "other-track", []Reservation{{Track: 1, Start: 0, End: 100}})
	// Train occupies [2,4) on track 0. Shifting by d conflicts with
	// blocker for d in [2,12] and with blocker2 for d in [17,22].
	mustAdd(t, p, "t", []Reservation{{Track: 0, Start: 2, End: 4}})
	if d, ok := p.EarliestShift("t", 0, MaxTime); !ok || d != 0 {
		t.Fatalf("EarliestShift(min=0) = %d,%v, want 0,true", d, ok)
	}
	if d, ok := p.EarliestShift("t", 2, MaxTime); !ok || d != 13 {
		t.Fatalf("EarliestShift(min=2) = %d,%v, want 13,true", d, ok)
	}
	if d, ok := p.EarliestShift("t", 17, MaxTime); !ok || d != 23 {
		t.Fatalf("EarliestShift(min=17) = %d,%v, want 23,true", d, ok)
	}
	if _, ok := p.EarliestShift("t", 2, 12); ok {
		t.Fatal("window fully covered by blocker must report infeasible")
	}
	// A train already at the domain end cannot shift at all.
	mustAdd(t, p, "edge", []Reservation{{Track: 2, Start: MaxTime - 1, End: MaxTime}})
	if _, ok := p.EarliestShift("edge", 1, 10); ok {
		t.Fatal("no room to shift within the time domain")
	}
	if d, ok := p.EarliestShift("edge", 0, 10); !ok || d != 0 {
		t.Fatalf("delta 0 must stay feasible, got %d,%v", d, ok)
	}
	if _, ok := p.EarliestShift("ghost", 0, 10); ok {
		t.Fatal("unknown train must report infeasible")
	}
}

// randomPlanner builds a random conflict-free planner.
func randomPlanner(rng *rand.Rand, trains int) (*Planner, []string) {
	p := New()
	var ids []string
	for len(ids) < trains {
		id := string(rune('A' + len(ids)))
		n := 1 + rng.Intn(3)
		res := make([]Reservation, 0, n)
		for len(res) < n {
			start := rng.Intn(MaxTime - 40)
			res = append(res, Reservation{
				Track: rng.Intn(3),
				Start: start,
				End:   start + 1 + rng.Intn(40),
			})
		}
		if err := p.AddTrain(id, res); err != nil {
			continue
		}
		ids = append(ids, id)
	}
	return p, ids
}

func clonePlanner(p *Planner, ids []string) *Planner {
	out := New()
	for _, id := range ids {
		if err := out.AddTrain(id, p.Reservations(id)); err != nil {
			panic(err)
		}
	}
	return out
}

func TestEarliestShiftMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 500; trial++ {
		p, ids := randomPlanner(rng, 2+rng.Intn(3))
		target := ids[rng.Intn(len(ids))]
		minDelta := rng.Intn(5)
		maxDelta := minDelta + rng.Intn(300)
		got, gotOK := p.EarliestShift(target, minDelta, maxDelta)
		want, wantOK := p.EarliestShiftBrute(target, minDelta, maxDelta)
		if gotOK != wantOK || got != want {
			t.Fatalf("trial %d: EarliestShift=%d,%v brute=%d,%v", trial, got, gotOK, want, wantOK)
		}
		if !gotOK {
			continue
		}
		// The reported delta must actually apply cleanly...
		if !clonePlanner(p, ids).Shift(target, got) {
			t.Fatalf("trial %d: reported delta %d does not apply", trial, got)
		}
		// ...and every smaller delta in the window must fail.
		for d := minDelta; d < got; d++ {
			if clonePlanner(p, ids).Shift(target, d) {
				t.Fatalf("trial %d: delta %d < earliest %d unexpectedly feasible", trial, d, got)
			}
		}
	}
}
