package railplan

import (
	"math/rand"
	"testing"
)

func TestEarliestShiftBasic(t *testing.T) {
	p := New()
	must := func(train string, layout []Reservation) {
		t.Helper()
		if err := p.Add(train, layout); err != nil {
			t.Fatal(err)
		}
	}
	// A occupies [0,10) and [20,30) on T1; B occupies [10,16).
	// Forbidden deltas from [0,10) vs [10,16): 10-10 < d < 16-0 -> [1,16).
	// Forbidden deltas from [20,30) vs [10,16): none in range.
	// Earliest feasible delay is therefore 16.
	must("A", []Reservation{res("T1", 0, 10), res("T1", 20, 30)})
	must("B", []Reservation{res("T1", 10, 16)})
	d, ok := p.EarliestShift("A", 1)
	if !ok || d != 16 {
		t.Fatalf("EarliestShift = %d,%v; want 16,true", d, ok)
	}
	// Delta 0 is feasible too when no minimum delay is required.
	if d, ok := p.EarliestShift("A", 0); !ok || d != 0 {
		t.Fatalf("EarliestShift(A,0) = %d,%v; want 0,true", d, ok)
	}
}

func TestEarliestShiftDomainBound(t *testing.T) {
	p := New()
	// X fills the whole domain: only delta 0 keeps it inside [0, MaxTime).
	if err := p.Add("X", []Reservation{res("T1", 0, MaxTime)}); err != nil {
		t.Fatal(err)
	}
	if _, ok := p.EarliestShift("X", 1); ok {
		t.Fatal("full-domain reservation cannot be delayed; want false")
	}
	// Y ends at MaxTime-5, so deltas above 5 leave the domain.
	if err := p.Add("Y", []Reservation{res("T2", 0, MaxTime-5)}); err != nil {
		t.Fatal(err)
	}
	if _, ok := p.EarliestShift("Y", 6); ok {
		t.Fatal("shift beyond the domain must report false")
	}
	if d, ok := p.EarliestShift("Y", 1); !ok || d != 1 {
		t.Fatalf("EarliestShift(Y,1) = %d,%v; want 1,true", d, ok)
	}
}

func TestEarliestShiftMatchesBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	tracks := []string{"T0", "T1", "T2"}
	for iter := 0; iter < 200; iter++ {
		p := New()
		nTrains := 2 + rng.Intn(5)
		for i := 0; i < nTrains; i++ {
			train := string(rune('A' + i))
			var layout []Reservation
			for j := 0; j < 1+rng.Intn(3); j++ {
				start := rng.Intn(MaxTime - 40)
				layout = append(layout, res(tracks[rng.Intn(len(tracks))], start, start+1+rng.Intn(40)))
			}
			// Keep only placements that fit; skip trains that never fit.
			_ = p.Add(train, layout)
		}
		trains := p.Trains()
		if len(trains) == 0 {
			continue
		}
		target := trains[rng.Intn(len(trains))]
		minDelta := rng.Intn(3)
		gotD, gotOK := p.EarliestShift(target, minDelta)
		wantD, wantOK := p.earliestShiftBrute(target, minDelta)
		if gotD != wantD || gotOK != wantOK {
			t.Fatalf("iter %d train %s minDelta %d: interval search = %d,%v; per-moment search = %d,%v",
				iter, target, minDelta, gotD, gotOK, wantD, wantOK)
		}
	}
}
