package main

import (
	"math/rand"
	"testing"
)

// Hand-computed instance: 2 registers, intervals a[0,3) b[1,2) c[2,4),
// call at point 2 reserves r1. Optimum is 1: a and b stay resident for
// free; c starts at p2 where only r0 is available (taken by a), so c
// starts spilled (store 1) and is never reloaded.
func TestFixedExample(t *testing.T) {
	in := &Input{
		Registers: []string{"r0", "r1"},
		Intervals: []Interval{
			{Name: "a", Start: 0, End: 3, LoadCost: 1, StoreCost: 1},
			{Name: "b", Start: 1, End: 2, LoadCost: 5, StoreCost: 5},
			{Name: "c", Start: 2, End: 4, LoadCost: 1, StoreCost: 1},
		},
		Calls: []Call{{Point: 2, Reserved: []string{"r1"}}},
	}
	sol, err := solveInstance(in)
	if err != nil {
		t.Fatal(err)
	}
	if sol.TotalCost != 1 {
		t.Fatalf("total cost = %d, want 1", sol.TotalCost)
	}
	if err := Verify(in, sol); err != nil {
		t.Fatalf("certificate invalid: %v", err)
	}
	// At the call point only r0 may be occupied.
	occ := sol.Points[2].Occupancy
	if len(occ) > 1 {
		t.Fatalf("point 2 occupancy %v exceeds available registers", occ)
	}
	for r := range occ {
		if r == "r1" {
			t.Fatalf("point 2 uses reserved register r1")
		}
	}
}

// All registers reserved at a point forces every live interval out.
func TestFullyReservedPoint(t *testing.T) {
	in := &Input{
		Registers: []string{"r0"},
		Intervals: []Interval{
			{Name: "a", Start: 0, End: 3, LoadCost: 2, StoreCost: 3},
		},
		Calls: []Call{{Point: 1, Reserved: []string{"r0"}}},
	}
	sol, err := solveInstance(in)
	if err != nil {
		t.Fatal(err)
	}
	// a must leave r0 at p1 (store 3); never reloading is free, so the
	// optimum is 3 rather than 3+2.
	if sol.TotalCost != 3 {
		t.Fatalf("total cost = %d, want 3", sol.TotalCost)
	}
	if len(sol.Points[1].Occupancy) != 0 {
		t.Fatalf("point 1 should have empty occupancy, got %v", sol.Points[1].Occupancy)
	}
	if err := Verify(in, sol); err != nil {
		t.Fatal(err)
	}
}

// randomInstance builds a small random valid instance.
func randomInstance(rng *rand.Rand) *Input {
	nRegs := 1 + rng.Intn(4)
	regs := []string{"r0", "r1", "r2", "r3"}[:nRegs]
	nIv := 1 + rng.Intn(6)
	maxP := 2 + rng.Intn(7)
	in := &Input{Registers: regs}
	for i := 0; i < nIv; i++ {
		s := rng.Intn(maxP - 1)
		e := s + 1 + rng.Intn(maxP-s)
		in.Intervals = append(in.Intervals, Interval{
			Name:      string(rune('a' + i)),
			Start:     s,
			End:       e,
			LoadCost:  rng.Intn(6),
			StoreCost: rng.Intn(6),
		})
	}
	nCalls := rng.Intn(3)
	maxEnd := 0
	for _, iv := range in.Intervals {
		if iv.End > maxEnd {
			maxEnd = iv.End
		}
	}
	for c := 0; c < nCalls; c++ {
		p := rng.Intn(maxEnd)
		var res []string
		for _, r := range regs {
			if rng.Intn(2) == 0 {
				res = append(res, r)
			}
		}
		in.Calls = append(in.Calls, Call{Point: p, Reserved: res})
	}
	return in
}

// The core check: DP optimum must equal exhaustive enumeration optimum,
// and the emitted certificate must verify, on many small instances.
func TestDPvsExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 500; trial++ {
		in := randomInstance(rng)
		sol, err := solveInstance(in)
		if err != nil {
			t.Fatalf("trial %d: solve: %v", trial, err)
		}
		if err := Verify(in, sol); err != nil {
			t.Fatalf("trial %d: verify: %v", trial, err)
		}
		bf, err := bruteForce(in)
		if err != nil {
			t.Fatalf("trial %d: brute force: %v", trial, err)
		}
		if sol.TotalCost != bf {
			t.Fatalf("trial %d: DP cost %d != exhaustive cost %d\ninput: %+v", trial, sol.TotalCost, bf, in)
		}
	}
}

// A tampered certificate must be rejected.
func TestVerifyRejectsTampering(t *testing.T) {
	in := &Input{
		Registers: []string{"r0", "r1"},
		Intervals: []Interval{
			{Name: "a", Start: 0, End: 3, LoadCost: 1, StoreCost: 1},
			{Name: "b", Start: 1, End: 2, LoadCost: 5, StoreCost: 5},
			{Name: "c", Start: 2, End: 4, LoadCost: 1, StoreCost: 1},
		},
		Calls: []Call{{Point: 2, Reserved: []string{"r1"}}},
	}
	sol, err := solveInstance(in)
	if err != nil {
		t.Fatal(err)
	}
	// Underreport the total cost.
	bad := *sol
	bad.TotalCost--
	if err := Verify(in, &bad); err == nil {
		t.Fatal("tampered total cost accepted")
	}
	// Occupy a reserved register.
	bad2 := *sol
	pts := make([]PointState, len(sol.Points))
	copy(pts, sol.Points)
	pts[2].Occupancy = map[string]string{"r1": "a"}
	bad2.Points = pts
	if err := Verify(in, &bad2); err == nil {
		t.Fatal("reserved-register occupancy accepted")
	}
	// Drop an event.
	bad3 := *sol
	if len(sol.Events) > 0 {
		bad3.Events = sol.Events[1:]
		if err := Verify(in, &bad3); err == nil {
			t.Fatal("missing event accepted")
		}
	}
}

func TestValidation(t *testing.T) {
	cases := []*Input{
		{Registers: nil, Intervals: []Interval{{Name: "a", Start: 0, End: 1}}},
		{Registers: []string{"r0", "r0"}, Intervals: []Interval{{Name: "a", Start: 0, End: 1}}},
		{Registers: []string{"r0"}, Intervals: []Interval{{Name: "a", Start: 2, End: 2}}},
		{Registers: []string{"r0"}, Intervals: []Interval{{Name: "a", Start: 0, End: 1, LoadCost: -1}}},
		{Registers: []string{"r0"}, Intervals: []Interval{{Name: "a", Start: 0, End: 1}}, Calls: []Call{{Point: 0, Reserved: []string{"r9"}}}},
	}
	for i, in := range cases {
		if _, err := solveInstance(in); err == nil {
			t.Fatalf("case %d: expected validation error", i)
		}
	}
}
